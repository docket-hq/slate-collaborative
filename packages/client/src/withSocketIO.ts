import io from 'socket.io-client'

import { AutomergeEditor } from './automerge-editor'

import { CollabAction } from '@slate-sheikah/bridge'

export interface SocketIOPluginOptions {
  url: string
  connectOpts: SocketIOClient.ConnectOpts
  presenceData?: Object
  autoConnect?: boolean

  onConnect?: () => void
  onDisconnect?: () => void
  onError?: (msg: string) => void
  onDocumentLoaded?: () => void
  onParticipantChange?: (msg: string) => void
}

export interface WithSocketIOEditor {
  socket: SocketIOClient.Socket

  connect: () => void
  disconnect: () => void

  send: (op: CollabAction) => void
  receive: (op: CollabAction) => void
  flush: () => void
}

/**
 * The `withSocketIO` plugin contains SocketIO layer logic.
 */

const withSocketIO = <T extends AutomergeEditor>(
  editor: T,
  options: SocketIOPluginOptions
) => {
  const e = editor as T & WithSocketIOEditor

  const {
    onConnect,
    onDisconnect,
    onDocumentLoaded = () => {},
    onParticipantChange = (msg: Object) => {},
    onError,
    connectOpts,
    presenceData,
    url,
    autoConnect
  } = options

  /**
   * Connect to Socket.
   */
  e.connect = () => {
    if (!e.socket) {
      connectOpts.query = connectOpts.query || {}
      connectOpts.query = {
        ...connectOpts.query,
        ...{ presenceData: JSON.stringify(presenceData || {}) }
      }
      e.socket = io(url, { ...connectOpts })

      e.socket.on('connect', () => {
        e.clientId = e.socket.id

        e.openConnection()

        onConnect && onConnect()
      })

      e.socket.on('disconnect', () => {
        e.gabageCursor()

        onDisconnect && onDisconnect()
      })

      e.socket.on('error', (msg: string) => {
        onError && onError(msg)
      })

      e.socket.on('msg', (data: CollabAction) => {
        e.receive(data)
      })
    }

    !e.socket.connected && e.socket.connect()

    return e
  }

  /**
   * Close socket and connection.
   */

  e.disconnect = () => {
    e.socket.close()

    e.closeConnection()

    return e
  }

  /**
   * Receive transport msg.
   */

  e.receive = (msg: CollabAction) => {
    switch (msg.type) {
      case 'operation':
        return e.receiveOperation(msg.payload)
      case 'document':
        return e.receiveDocument(msg.id, msg.payload, onDocumentLoaded)
      case 'participant':
        return onParticipantChange && onParticipantChange(msg.payload)
    }
  }

  /**
   * Send message to socket.
   */

  e.send = (msg: CollabAction) => {
    e.socket.emit('msg', msg)
  }

  /**
   * sends flush to socket.
   */
  e.flush = () => {
    e.socket.emit('flush')
  }

  autoConnect && e.connect()

  return e
}

export default withSocketIO
