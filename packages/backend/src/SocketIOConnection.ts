import io from 'socket.io'
import * as Automerge from 'automerge'
import { Node } from 'slate'
import { Server } from 'http'

import throttle from 'lodash/throttle'

import { SyncDoc, CollabAction, toJS } from '@slate-sheikah/bridge'

import { getClients } from './utils'

import AutomergeBackend from './AutomergeBackend'
import { SocketIOConnection } from 'index'

export interface SocketIOCollaborationOptions {
  entry: Server
  connectOpts?: SocketIO.ServerOptions
  defaultValue?: Node[]
  saveFrequency?: number
  cleanFrequency?: number
  cleanThreshold?: number
  onAuthRequest?: (
    query: Object,
    socket?: SocketIO.Socket
  ) => Promise<boolean> | boolean
  onDocumentLoad?: (
    pathname: string,
    query?: Object
  ) => Promise<Node[]> | Node[]
  onDocumentSave?: (pathname: string, doc: Node[]) => Promise<void> | void
  onSocketConnection?: (
    metadata: ConnectionCallbackMeta
  ) => Promise<void> | void
  onSocketDisconnection?: (
    metadata: ConnectionCallbackMeta
  ) => Promise<void> | void
}
export interface BackendCounts {
  [key: string]: number
}

export interface ConnectionCallbackMeta {
  docId: string
  socket: SocketIO.Socket
  _this: SocketIOConnection
}

export interface Backends {
  automerge: AutomergeBackend
  ready: boolean
  failed: boolean
  cleanupTimer: number
}

export default class SocketIOCollaboration {
  private io: SocketIO.Server
  private options: SocketIOCollaborationOptions
  private backends: Backends[] = []
  private backendCounts: BackendCounts[] = []

  /**
   * Constructor
   */

  constructor(options: SocketIOCollaborationOptions) {
    this.io = io(options.entry, {
      ...options.connectOpts,
      perMessageDeflate: true
    })

    this.options = options

    this.configure()

    this.autoSaveDoc = throttle(
      this.saveDocument,
      options.saveFrequency || 2000
    )

    this.backends = []
    this.backendCounts = []

    //spawn cleaner
    setInterval(() => {
      this.cleaner()
    }, options.cleanFrequency || 60000)

    return this
  }

  /**
   * Initial IO configuration
   */

  private configure = () =>
    this.io
      .of(this.nspMiddleware)
      .use(this.authMiddleware)
      .on('connect', this.onConnect)

  /**
   * Namespace SocketIO middleware. Load document value and append it to CollaborationBackend.
   */

  private nspMiddleware = async (path: string, query: any, next: any) => {
    return next(null, true)
    //this is needed to set up the namespace, but it only runs once.
    //the logic that WAS in here needs to be able to be ran multiple times.
  }

  /**
   * init function to set up new documents is they don't exist.  These get cleaned up once
   * all the sockets disconnect.
   * @param socket
   */
  private init = async (socket: SocketIO.Socket) => {
    const path = socket.nsp.name
    try {
      const query = socket.handshake.query
      const { onDocumentLoad } = this.options

      //make some backends if this is the first time this meeting is loaded.
      if (!this.backends[path]) {
        this.backends[path] = {
          automerge: new AutomergeBackend(),
          cleanupTimer:
            Math.floor(Date.now() / 1000) +
            (this.options.cleanThreshold || 30) * 60,
          loadDocument: (async () => {
            const automerge = new AutomergeBackend()

            const doc = onDocumentLoad
              ? await onDocumentLoad(path, query)
              : this.options.defaultValue

            if (doc) {
              automerge.appendDocument(path, doc)
              this.backends[path].automerge = automerge
            }
          })()
        }
        this.backendCounts[path] = 0
      }
    } catch (e) {
      console.log('Error in slate-collab init', e)
    }

    //return a promise for creating the automergebackend so we can await on that being done
    return this.backends[path].loadDocument
  }

  /**
   * memory cleaner process that checks the backeds to see if there aren't connections and if the timer has expired.
   */
  private cleaner() {
    console.log('Cleaner running')
    const targets: string[] = []

    try {
      Object.keys(this.backends).forEach(key => {
        if (
          this.backendCounts[key] === 0 &&
          this.backends[key].cleanupTimer < Math.floor(Date.now() / 1000)
        ) {
          targets.push(key)
        }
      })

      console.log(`Found ${targets.length} documents to clean.`)
      if (targets.length) {
        //free up that precious, precious memory.
        targets.forEach(key => {
          delete this.backends[key]
          delete this.io.nsps[key]
          delete this.backendCounts[key]
        })
      }
    } catch (e) {
      console.log('Error freeing memory', e)
    }
  }

  /**
   * SocketIO auth middleware. Used for user authentification.
   */

  private authMiddleware = async (
    socket: SocketIO.Socket,
    next: (e?: any) => void
  ) => {
    const { query } = socket.handshake
    const { onAuthRequest } = this.options

    if (onAuthRequest) {
      const permit = await onAuthRequest(query, socket)

      if (!permit) return next(new Error(`Authentication error: ${socket.id}`))
    }

    return next()
  }

  /**
   * On 'connect' handler.
   */

  private onConnect = async (socket: SocketIO.Socket) => {
    try {
      const { name } = socket.nsp
      const { onSocketConnection } = this.options
      const { id, conn } = socket

      await this.init(socket)
      this.backendCounts[name] = this.backendCounts[name] + 1

      this.backends[name].automerge.createConnection(
        id,
        ({ type, payload }: CollabAction) => {
          socket
            .compress(false)
            .emit('msg', { type, payload: { id: conn.id, ...payload } })
        }
      )

      socket.on('msg', this.onMessage(id, name))

      socket.on('disconnect', this.onDisconnect(id, socket))

      const doc = this.backends[name].automerge.getDocument(name)

      socket.compress(true).emit('msg', {
        type: 'document',
        payload: Automerge.save<SyncDoc>(doc)
      })
      this.backends[name].automerge.openConnection(id)

      this.garbageCursors(name)

      onSocketConnection &&
        (await onSocketConnection({
          docId: name,
          socket,
          _this: this
        }))
    } catch (e) {
      console.log('Error in slate-collab onConnect', e)
    }
  }

  /**
   * On 'message' handler
   */

  private onMessage = (id: string, name: string) => (data: any) => {
    switch (data.type) {
      case 'operation':
        try {
          this.backends[name].automerge.receiveOperation(id, data)

          this.autoSaveDoc(name)

          this.garbageCursors(name)
        } catch (e) {
          console.log(e)
        }
    }
  }

  private autoSaveDoc = (name: string) => {
    //noop to be overwritten by the constructor.
  }

  /**
   * Save document
   */

  private saveDocument = async (docId: string) => {
    try {
      const { onDocumentSave } = this.options

      //if the backend has already been cleaned up, stop trying to do this.
      if (!this.backends[docId]) {
        return
      }

      const doc = this.backends[docId].automerge.getDocument(docId)

      if (!doc) {
        throw new Error(`Can't receive document by id: ${docId}`)
      }

      onDocumentSave && (await onDocumentSave(docId, toJS(doc.children)))
    } catch (e) {
      console.error(e, docId)
    }
  }

  /**
   * On 'disconnect' handler
   */

  private onDisconnect = (id: string, socket: SocketIO.Socket) => async () => {
    try {
      const { onSocketDisconnection } = this.options

      //increment the cleanup timer
      this.backends[socket.nsp.name].cleanupTimer =
        Math.floor(Date.now() / 1000) + (this.options.cleanThreshold || 30) * 60

      this.backends[socket.nsp.name].automerge.closeConnection(id)
      this.backendCounts[socket.nsp.name] =
        this.backendCounts[socket.nsp.name] - 1

      await this.saveDocument(socket.nsp.name)

      this.garbageCursors(socket.nsp.name)

      onSocketDisconnection &&
        (await onSocketDisconnection({
          docId: socket.nsp.name,
          socket,
          _this: this
        }))
    } catch (e) {
      console.log('Error in slate-collab onDisconnect', e)
    }
  }

  /**
   * Clean up unused cursor data.
   */

  garbageCursors = (nsp: string) => {
    try {
      const doc = this.backends[nsp].automerge.getDocument(nsp)

      if (!doc.cursors) return

      const namespace = this.io.of(nsp)

      Object.keys(doc?.cursors)?.forEach(key => {
        if (!namespace.sockets[key]) {
          this.backends[nsp].automerge.garbageCursor(nsp, key)
        }
      })
    } catch (e) {
      //don't necessarily care if this fails.
    }
  }

  /**
   * Destroy SocketIO connection
   */

  destroy = async () => {
    this.io.close()
  }
}
