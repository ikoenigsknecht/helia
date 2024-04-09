import { CodeError, setMaxListeners, start, stop } from '@libp2p/interface'
import { anySignal } from 'any-signal'
import { IdentityBlockstore } from 'blockstore-core/identity'
import { TieredBlockstore } from 'blockstore-core/tiered'
import filter from 'it-filter'
import forEach from 'it-foreach'
import { CustomProgressEvent, type ProgressOptions } from 'progress-events'
import { equals as uint8ArrayEquals } from 'uint8arrays/equals'
import type { BlockBroker, Blocks, Pair, DeleteManyBlocksProgressEvents, DeleteBlockProgressEvents, GetBlockProgressEvents, GetManyBlocksProgressEvents, PutManyBlocksProgressEvents, PutBlockProgressEvents, GetAllBlocksProgressEvents, GetOfflineOptions, BlockRetrievalOptions } from '@helia/interface/blocks'
import type { AbortOptions, ComponentLogger, Logger, LoggerOptions, Startable } from '@libp2p/interface'
import type { Blockstore } from 'interface-blockstore'
import type { AwaitIterable } from 'interface-store'
import type { CID } from 'multiformats/cid'
import type { MultihashHasher } from 'multiformats/hashes/interface'

export interface NetworkedStorageInit {
  root?: CID
}

export interface GetOptions extends AbortOptions {
  progress?(evt: Event): void
}

export interface NetworkedStorageComponents {
  blockstore: Blockstore
  logger: ComponentLogger
  blockBrokers: BlockBroker[]
  hashers: Record<number, MultihashHasher>
}

/**
 * Networked storage wraps a regular blockstore - when getting blocks if the
 * blocks are not present Bitswap will be used to fetch them from network peers.
 */
export class NetworkedStorage implements Blocks, Startable {
  private readonly child: Blockstore
  private readonly hashers: Record<number, MultihashHasher>
  private started: boolean
  private readonly log: Logger
  private readonly logger: ComponentLogger
  private readonly components: NetworkedStorageComponents

  /**
   * Create a new BlockStorage
   */
  constructor (components: NetworkedStorageComponents, init: NetworkedStorageInit = {}) {
    this.log = components.logger.forComponent(`helia:networked-storage${init.root == null ? '' : `:${init.root}`}`)
    this.logger = components.logger
    this.components = components
    this.child = new TieredBlockstore([
      new IdentityBlockstore(),
      components.blockstore
    ])
    this.hashers = components.hashers ?? {}
    this.started = false
  }

  isStarted (): boolean {
    return this.started
  }

  async start (): Promise<void> {
    await start(this.child, ...this.components.blockBrokers)
    this.started = true
  }

  async stop (): Promise<void> {
    await stop(this.child, ...this.components.blockBrokers)
    this.started = false
  }

  unwrap (): Blockstore {
    return this.child
  }

  /**
   * Put a block to the underlying datastore
   */
  async put (cid: CID, block: Uint8Array, options: AbortOptions & ProgressOptions<PutBlockProgressEvents> = {}): Promise<CID> {
    if (await this.child.has(cid)) {
      options.onProgress?.(new CustomProgressEvent<CID>('blocks:put:duplicate', cid))
      return cid
    }

    options.onProgress?.(new CustomProgressEvent<CID>('blocks:put:providers:notify', cid))

    await Promise.all(
      this.components.blockBrokers.map(async broker => broker.announce?.(cid, block, options))
    )

    options.onProgress?.(new CustomProgressEvent<CID>('blocks:put:blockstore:put', cid))

    return this.child.put(cid, block, options)
  }

  /**
   * Put a multiple blocks to the underlying datastore
   */
  async * putMany (blocks: AwaitIterable<{ cid: CID, block: Uint8Array }>, options: AbortOptions & ProgressOptions<PutManyBlocksProgressEvents> = {}): AsyncIterable<CID> {
    const missingBlocks = filter(blocks, async ({ cid }): Promise<boolean> => {
      const has = await this.child.has(cid)

      if (has) {
        options.onProgress?.(new CustomProgressEvent<CID>('blocks:put-many:duplicate', cid))
      }

      return !has
    })

    const notifyEach = forEach(missingBlocks, async ({ cid, block }): Promise<void> => {
      options.onProgress?.(new CustomProgressEvent<CID>('blocks:put-many:providers:notify', cid))
      await Promise.all(
        this.components.blockBrokers.map(async broker => broker.announce?.(cid, block, options))
      )
    })

    options.onProgress?.(new CustomProgressEvent('blocks:put-many:blockstore:put-many'))
    yield * this.child.putMany(notifyEach, options)
  }

  /**
   * Get a block by cid
   */
  async get (cid: CID, options: GetOfflineOptions & AbortOptions & ProgressOptions<GetBlockProgressEvents> = {}): Promise<Uint8Array> {
    if (options.offline !== true && !(await this.child.has(cid))) {
      // we do not have the block locally, get it from a block provider
      options.onProgress?.(new CustomProgressEvent<CID>('blocks:get:providers:get', cid))
      const block = await raceBlockRetrievers(cid, this.components.blockBrokers, this.hashers[cid.multihash.code], {
        ...options,
        log: this.log
      })
      options.onProgress?.(new CustomProgressEvent<CID>('blocks:get:blockstore:put', cid))
      await this.child.put(cid, block, options)

      // notify other block providers of the new block
      options.onProgress?.(new CustomProgressEvent<CID>('blocks:get:providers:notify', cid))
      await Promise.all(
        this.components.blockBrokers.map(async broker => broker.announce?.(cid, block, options))
      )

      return block
    }

    options.onProgress?.(new CustomProgressEvent<CID>('blocks:get:blockstore:get', cid))

    return this.child.get(cid, options)
  }

  /**
   * Get multiple blocks back from an (async) iterable of cids
   */
  async * getMany (cids: AwaitIterable<CID>, options: GetOfflineOptions & AbortOptions & ProgressOptions<GetManyBlocksProgressEvents> = {}): AsyncIterable<Pair> {
    options.onProgress?.(new CustomProgressEvent('blocks:get-many:blockstore:get-many'))

    yield * this.child.getMany(forEach(cids, async (cid): Promise<void> => {
      if (options.offline !== true && !(await this.child.has(cid))) {
        // we do not have the block locally, get it from a block provider
        options.onProgress?.(new CustomProgressEvent<CID>('blocks:get-many:providers:get', cid))
        const block = await raceBlockRetrievers(cid, this.components.blockBrokers, this.hashers[cid.multihash.code], {
          ...options,
          log: this.log
        })
        options.onProgress?.(new CustomProgressEvent<CID>('blocks:get-many:blockstore:put', cid))
        await this.child.put(cid, block, options)

        // notify other block providers of the new block
        options.onProgress?.(new CustomProgressEvent<CID>('blocks:get-many:providers:notify', cid))
        await Promise.all(
          this.components.blockBrokers.map(async broker => broker.announce?.(cid, block, options))
        )
      }
    }))
  }

  /**
   * Delete a block from the blockstore
   */
  async delete (cid: CID, options: AbortOptions & ProgressOptions<DeleteBlockProgressEvents> = {}): Promise<void> {
    options.onProgress?.(new CustomProgressEvent<CID>('blocks:delete:blockstore:delete', cid))

    await this.child.delete(cid, options)
  }

  /**
   * Delete multiple blocks from the blockstore
   */
  async * deleteMany (cids: AwaitIterable<CID>, options: AbortOptions & ProgressOptions<DeleteManyBlocksProgressEvents> = {}): AsyncIterable<CID> {
    options.onProgress?.(new CustomProgressEvent('blocks:delete-many:blockstore:delete-many'))
    yield * this.child.deleteMany((async function * (): AsyncGenerator<CID> {
      for await (const cid of cids) {
        yield cid
      }
    }()), options)
  }

  async has (cid: CID, options: AbortOptions = {}): Promise<boolean> {
    return this.child.has(cid, options)
  }

  async * getAll (options: AbortOptions & ProgressOptions<GetAllBlocksProgressEvents> = {}): AwaitIterable<Pair> {
    options.onProgress?.(new CustomProgressEvent('blocks:get-all:blockstore:get-many'))
    yield * this.child.getAll(options)
  }

  async createSession (root: CID, options?: AbortOptions & ProgressOptions<GetBlockProgressEvents>): Promise<Blocks> {
    const blockBrokers = await Promise.all(this.components.blockBrokers.map(async broker => {
      if (broker.createSession == null) {
        return broker
      }

      return broker.createSession(root, options)
    }))

    return new NetworkedStorage({
      blockstore: this.child,
      blockBrokers,
      hashers: this.hashers,
      logger: this.logger
    }, {
      root
    })
  }
}

function isRetrievingBlockBroker (broker: BlockBroker): broker is Required<Pick<BlockBroker, 'retrieve'>> {
  return typeof broker.retrieve === 'function'
}
export const getCidBlockVerifierFunction = (cid: CID, hasher: MultihashHasher): Required<BlockRetrievalOptions>['validateFn'] => {
  if (hasher == null) {
    throw new CodeError(`No hasher configured for multihash code 0x${cid.multihash.code.toString(16)}, please configure one. You can look up which hash this is at https://github.com/multiformats/multicodec/blob/master/table.csv`, 'ERR_UNKNOWN_HASH_ALG')
  }

  return async (block: Uint8Array): Promise<void> => {
    // verify block
    const hash = await hasher.digest(block)

    if (!uint8ArrayEquals(hash.digest, cid.multihash.digest)) {
      // if a hash mismatch occurs for a TrustlessGatewayBlockBroker, we should try another gateway
      throw new CodeError('Hash of downloaded block did not match multihash from passed CID', 'ERR_HASH_MISMATCH')
    }
  }
}

/**
 * Race block providers cancelling any pending requests once the block has been
 * found.
 */
async function raceBlockRetrievers (cid: CID, blockBrokers: BlockBroker[], hasher: MultihashHasher, options: AbortOptions & LoggerOptions): Promise<Uint8Array> {
  const validateFn = getCidBlockVerifierFunction(cid, hasher)

  const controller = new AbortController()
  const signal = anySignal([controller.signal, options.signal])
  setMaxListeners(Infinity, controller.signal, signal)

  const retrievers: Array<Required<Pick<BlockBroker, 'retrieve'>>> = []

  for (const broker of blockBrokers) {
    if (isRetrievingBlockBroker(broker)) {
      retrievers.push(broker)
    }
  }

  try {
    return await Promise.any(
      retrievers
        .map(async retriever => {
          try {
            let blocksWereValidated = false
            const block = await retriever.retrieve(cid, {
              ...options,
              signal,
              validateFn: async (block: Uint8Array): Promise<void> => {
                await validateFn(block)
                blocksWereValidated = true
              }
            })

            if (!blocksWereValidated) {
              // the blockBroker either did not throw an error when attempting to validate the block
              // or did not call the validateFn at all. We should validate the block ourselves
              await validateFn(block)
            }

            return block
          } catch (err) {
            options.log.error('could not retrieve verified block for %c', cid, err)
            throw err
          }
        })
    )
  } finally {
    signal.clear()
  }
}
