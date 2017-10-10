/*
 * vim: ts=4:sw=4:expandtab
 */

'use strict';

const Long = require('long');
const WebSocket = require('ws');
const crypto = require('crypto');
const protobufs = require('./protobufs');


const MSG_TYPES = protobufs.WebSocketMessage.lookup('Type').values;


class Request {
    constructor(wsr, options) {
        this.wsr = wsr;
        this.verb = options.verb || options.type;
        this.path = options.path || options.url;
        this.body = options.body || options.data;
        this.success = options.success;
        this.error = options.error;
        this.id = options.id;
        if (!this.id) {
            var ints = new Uint32Array(2);
            ints.set(crypto.randomBytes(ints.length));
            this.id = new Long(ints[0], ints[1], true /*unsigned*/);
        }
        if (this.body === undefined) {
            this.body = null;
        }
    }
}

class IncomingWebSocketRequest extends Request {
    respond(status, message) {
        const pbmsg = protobufs.WebSocketMessage.create({
            type: MSG_TYPES.RESPONSE,
            response: {
                id: this.id,
                message,
                status
            }
        });
        return this.wsr.socket.send(protobufs.WebSocketMessage.encode(pbmsg).finish());
    }
}

class OutgoingWebSocketRequest extends Request {
    send() {
        const pbmsg = protobufs.WebSocketMessage.create({
            type: MSG_TYPES.REQUEST,
            request: {
                verb: this.verb,
                path: this.path,
                body: this.body,
                id: this.id
            }
        });
        return this.wsr.socket.send(protobufs.WebSocketMessage.encode(pbmsg).finish());
    }
}

class KeepAlive {
    constructor(websocketResource, opts) {
        if (!(websocketResource instanceof WebSocketResource)) {
            throw new TypeError('KeepAlive expected a WebSocketResource');
        }
        opts = opts || {};
        this.path = opts.path;
        if (this.path === undefined) {
            this.path = '/';
        }
        this.disconnect = opts.disconnect;
        if (this.disconnect === undefined) {
            this.disconnect = true;
        }
        this.wsr = websocketResource;
    }

    stop() {
        clearTimeout(this.keepAliveTimer);
        clearTimeout(this.disconnectTimer);
    }

    reset() {
        clearTimeout(this.keepAliveTimer);
        clearTimeout(this.disconnectTimer);
        this.keepAliveTimer = setTimeout(function() {
            this.wsr.sendRequest({
                verb: 'GET',
                path: this.path,
                success: this.reset.bind(this)
            });
            if (this.disconnect) {
                // automatically disconnect if server doesn't ack
                this.disconnectTimer = setTimeout(function() {
                    clearTimeout(this.keepAliveTimer);
                    this.wsr.close(3001, 'No response to keepalive request');
                }.bind(this), 1000);
            } else {
                this.reset();
            }
        }.bind(this), 50000);
    }
}

class WebSocketResource {

    constructor(url, opts) {
        this.url = url;
        this.socket = null;
        this._outgoingRequests = new Map();
        this._listeners = [];
        opts = opts || {};
        this.handleRequest = opts.handleRequest;
        if (typeof this.handleRequest !== 'function') {
            this.handleRequest = request => request.respond(404, 'Not found');
        }
        this.addEventListener('message', this.onMessage.bind(this));
        if (opts.keepalive) {
            const keepalive = new KeepAlive(this, {
                path: opts.keepalive.path,
                disconnect: opts.keepalive.disconnect
            });
            const resetKeepAliveTimer = keepalive.reset.bind(keepalive);
            this.addEventListener('open', resetKeepAliveTimer);
            this.addEventListener('message', resetKeepAliveTimer);
            this.addEventListener('close', keepalive.stop.bind(keepalive));
        }
    }

    addEventListener(event, callback) {
        this._listeners.push([event, callback]);
        if (this.socket) {
            this.socket.addEventListener(event, callback);
        }
    }

    removeEventListener(event, callback) {
        if (this.socket) {
            this.socket.removeEventListener(event, callback);
        }
        this._listeners = this._listeners.filter(x => !(x[0] === event && x[1] === callback));
    }

    connect() {
        this.close();
        this.socket = new WebSocket(this.url);
        for (const x of this._listeners) {
            this.socket.addEventListener(x[0], x[1]);
        }
        console.info('Websocket connecting:', this.url.split('?', 1)[0]);
    }

    close(code, reason) {
        if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
            if (!code) {
                code = 3000;
            }
            this.socket.close(code, reason);
        }
        this.socket = null;
    }

    sendRequest(options) {
        const request = new OutgoingWebSocketRequest(this, options);
        this._outgoingRequests.set(request.id.toNumber(), request);
        request.send();
        return request;
    }

    async onMessage(encodedMsg) {
        const messageProto = protobufs.WebSocketMessage.decode(Buffer.from(encodedMsg.data));
        const message = protobufs.WebSocketMessage.toObject(messageProto);
        if (message.type === MSG_TYPES.REQUEST) {
            await this.handleRequest(new IncomingWebSocketRequest(this, {
                verb: message.request.verb,
                path: message.request.path,
                body: message.request.body,
                id: message.request.id
            }));
        } else if (message.type === MSG_TYPES.RESPONSE) {
            const response = message.response;
            const key = response.id.toNumber();
            if (this._outgoingRequests.has(key)) {
                const request = this._outgoingRequests.get(key);
                this._outgoingRequests.delete(key);
                request.response = response;
                let callback;
                if (response.status >= 200 && response.status < 300) {
                    callback = request.success;
                } else {
                    callback = request.error;
                }
                if (typeof callback === 'function') {
                    await callback(response.message, response.status, request);
                }
            } else {
                console.error('Unmatched websocket response', key, message, encodedMsg);
                throw ReferenceError('Unmatched WebSocket Response');
            }
        } else {
            throw new TypeError(`Unhandled message type: ${message.type}`);
        }
    }
}

module.exports = WebSocketResource;
