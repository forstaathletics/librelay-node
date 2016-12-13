/*
 * vim: ts=4:sw=4:expandtab
 */

'use strict';

const EventTarget = require('./event_target.js');
const WebSocket = require('websocket').w3cwebsocket;
const WebSocketResource = require('./websocket-resources.js');
const api = require('./api.js');
const crypto = require('./crypto.js');
const errors = require('./errors.js');
const libsignal = require('libsignal');
const protobufs = require('./protobufs.js');
const storage = require('./storage');


function MessageReceiver(url, username, password, signalingKey, attachment_server_url) {
    this.url = url;
    this.signalingKey = signalingKey;
    this.username = username;
    this.password = password;
    this.server = new api.RelayServer(url, username, password, attachment_server_url);

    var address = libsignal.SignalProtocolAddress.fromString(username);
    this.number = address.getName();
    this.deviceId = address.getDeviceId();
}

MessageReceiver.prototype = new EventTarget();
MessageReceiver.prototype.extend({
    constructor: MessageReceiver,
    connect: function() {
        if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
            this.socket.close();
        }
        console.log('opening websocket', this.url);
        // initialize the socket and start listening for messages
        this.socket = this.server.getMessageSocket();
        this.socket.onclose = this.onclose.bind(this);
        this.socket.onerror = this.onerror.bind(this);
        this.socket.onopen = this.onopen.bind(this);
        this.wsr = new WebSocketResource(this.socket, {
            handleRequest: this.handleRequest.bind(this),
            keepalive: { path: '/v1/keepalive', disconnect: true }
        });
        this.pending = Promise.resolve();
    },
    close: function() {
        this.socket.close(3000, 'called close');
        delete this.listeners;
    },
    onopen: function() {
        console.log('websocket open');
    },
    onerror: function(error) {
        console.log('websocket error');
    },
    onclose: function(ev) {
        console.log('websocket closed', ev.code, ev.reason || '');
        if (ev.code === 3000) {
            return;
        }
        var eventTarget = this;
        // possible 403 or network issue. Make an request to confirm
        this.server.getDevices(this.number).
            then(this.connect.bind(this)). // No HTTP error? Reconnect
            catch(function(e) {
                var ev = new Event('error');
                ev.error = e;
                eventTarget.dispatchEvent(ev);
            });
    },
    handleRequest: function(request) {
        // We do the message decryption here, instead of in the ordered pending queue,
        // to avoid exposing the time it took us to process messages through the time-to-ack.

        // TODO: handle different types of requests. for now we blindly assume
        // PUT /messages <encrypted Envelope>
        crypto.decryptWebsocketMessage(request.body, this.signalingKey).then(function(plaintext) {
            console.log("XXXX", plaintext);
            var envelope = protobufs.Envelope.decode(plaintext);
            console.log("XXXX EVN", envelope);
            // After this point, decoding errors are not the server's
            // fault, and we should handle them gracefully and tell the
            // user they received an invalid message
            request.respond(200, 'OK');

            if (!this.isBlocked(envelope.source)) {
                this.queueEnvelope(envelope);
            }

        }.bind(this)).catch(function(e) {
            request.respond(500, 'Bad encrypted websocket message');
            console.log("Error handling incoming message:", e);
            var ev = new Event('error');
            ev.error = e;
            this.dispatchEvent(ev);
        }.bind(this));
    },
    queueEnvelope: function(envelope) {
        var handleEnvelope = this.handleEnvelope.bind(this, envelope);
        this.pending = this.pending.then(handleEnvelope, handleEnvelope);
    },
    handleEnvelope: function(envelope) {
        if (envelope.type === protobufs.Envelope.Type.RECEIPT) {
            return this.onDeliveryReceipt(envelope);
        }

        if (envelope.content) {
            return this.handleContentMessage(envelope);
        } else if (envelope.legacyMessage) {
            return this.handleLegacyMessage(envelope);
        } else {
            throw new Error('Received message with no content and no legacyMessage');
        }
    },
    getStatus: function() {
        if (this.socket) {
            return this.socket.readyState;
        } else {
            return -1;
        }
    },
    onDeliveryReceipt: function (envelope) {
        var ev = new Event('receipt');
        ev.proto = envelope;
        this.dispatchEvent(ev);
    },
    unpad: function(paddedPlaintext) {
        console.log("IN");
        console.log("IN");
        console.log("IN");
        console.log("IN");
        paddedPlaintext = new Uint8Array(paddedPlaintext);
        console.log(11111, paddedPlaintext);
        var plaintext;
        for (var i = paddedPlaintext.length - 1; i >= 0; i--) {
            console.log("lOOP");
            if (paddedPlaintext[i] == 0x80) {
                plaintext = new Uint8Array(i);
                plaintext.set(paddedPlaintext.subarray(0, i));
                plaintext = plaintext.buffer;
                break;
            } else if (paddedPlaintext[i] !== 0x00) {
                throw new Error('Invalid padding');
            }
        }
        console.log("OUT", plaintext);

        return plaintext;
    },
    decrypt: function(envelope, ciphertext) {
        var promise;
        var address = new libsignal.SignalProtocolAddress(envelope.source, envelope.sourceDevice);
        // XXX This is fucked.
        console.log('address', address);
        console.log('address', address);
        var sessionCipher = new libsignal.SessionCipher(storage.protocol, address);
        switch(envelope.type) {
            case protobufs.Envelope.Type.CIPHERTEXT:
                console.log('message from', envelope.source + '.' + envelope.sourceDevice, envelope.timestamp.toNumber());
                promise = sessionCipher.decryptWhisperMessage(ciphertext).then(this.unpad);
                break;
            case protobufs.Envelope.Type.PREKEY_BUNDLE:
                console.log('prekey message from', envelope.source + '.' + envelope.sourceDevice, envelope.timestamp.toNumber());
                promise = this.decryptPreKeyWhisperMessage(ciphertext, sessionCipher, address);
                break;
            default:
                promise = Promise.reject(new Error("Unknown message type"));
        }
        return promise.catch(function(error) {
            var ev = new Event('error');
            ev.error = error;
            ev.proto = envelope;
            this.dispatchEvent(ev);
            return Promise.reject(error);
        }.bind(this));
    },
    decryptPreKeyWhisperMessage: function(ciphertext, sessionCipher, address) {
        return sessionCipher.decryptPreKeyWhisperMessage(ciphertext).then(this.unpad).catch(function(e) {
            console.log("NO", e);
            if (e.message === 'Unknown identity key') {
                // create an error that the UI will pick up and ask the
                // user if they want to re-negotiate
                throw new errors.IncomingIdentityKeyError(
                    address.toString(),
                    ciphertext.toArrayBuffer(),
                    e.identityKey
                );
            }
            throw e;
        });
    },
    handleSentMessage: function(destination, timestamp, message, expirationStartTimestamp) {
        var p = Promise.resolve();
        if ((message.flags & protobufs.DataMessage.Flags.END_SESSION) ==
                protobufs.DataMessage.Flags.END_SESSION ) {
            p = this.handleEndSession(destination);
        }
        return p.then(function() {
            return this.processDecrypted(message, this.number).then(function(message) {
                var ev = new Event('sent');
                ev.data = {
                    destination              : destination,
                    timestamp                : timestamp.toNumber(),
                    message                  : message
                };
                if (expirationStartTimestamp) {
                  ev.data.expirationStartTimestamp = expirationStartTimestamp.toNumber();
                }
                this.dispatchEvent(ev);
            }.bind(this));
        }.bind(this));
    },
    handleDataMessage: function(envelope, message) {
        var encodedNumber = envelope.source + '.' + envelope.sourceDevice;
        console.log('data message from', encodedNumber, envelope.timestamp.toNumber());
        var p = Promise.resolve();
        if ((message.flags & protobufs.DataMessage.Flags.END_SESSION) ==
                protobufs.DataMessage.Flags.END_SESSION ) {
            p = this.handleEndSession(envelope.source);
        }
        return p.then(function() {
            return this.processDecrypted(message, envelope.source).then(function(message) {
                var ev = new Event('message');
                ev.data = {
                    source    : envelope.source,
                    timestamp : envelope.timestamp.toNumber(),
                    message   : message
                };
                this.dispatchEvent(ev);
            }.bind(this));
        }.bind(this));
    },
    handleLegacyMessage: function (envelope) {
        return this.decrypt(envelope, envelope.legacyMessage).then(function(plaintext) {
            var message = protobufs.DataMessage.decode(plaintext);
            return this.handleDataMessage(envelope, message);
        }.bind(this));
    },
    handleContentMessage: function (envelope) {
        return this.decrypt(envelope, envelope.content).then(function(plaintext) {
            var content = protobufs.Content.decode(plaintext);
            if (content.syncMessage) {
                return this.handleSyncMessage(envelope, content.syncMessage);
            } else if (content.dataMessage) {
                return this.handleDataMessage(envelope, content.dataMessage);
            } else {
                throw new Error('Got Content message with no dataMessage and no syncMessage');
            }
        }.bind(this));
    },
    handleSyncMessage: function(envelope, syncMessage) {
        if (envelope.source !== this.number) {
            throw new Error('Received sync message from another number');
        }
        if (envelope.sourceDevice == this.deviceId) {
            throw new Error('Received sync message from our own device');
        }
        if (syncMessage.sent) {
            var sentMessage = syncMessage.sent;
            console.log('sent message to',
                    sentMessage.destination,
                    sentMessage.timestamp.toNumber(),
                    'from', envelope.source + '.' + envelope.sourceDevice
            );
            return this.handleSentMessage(
                    sentMessage.destination,
                    sentMessage.timestamp,
                    sentMessage.message,
                    sentMessage.expirationStartTimestamp
            );
        } else if (syncMessage.contacts) {
            this.handleContacts(syncMessage.contacts);
        } else if (syncMessage.groups) {
            this.handleGroups(syncMessage.groups);
        } else if (syncMessage.blocked) {
            this.handleBlocked(syncMessage.blocked);
        } else if (syncMessage.request) {
            console.log('Got SyncMessage Request');
        } else if (syncMessage.read) {
            console.log('read messages',
                    'from', envelope.source + '.' + envelope.sourceDevice);
            this.handleRead(syncMessage.read, envelope.timestamp);
        } else {
            throw new Error('Got empty SyncMessage');
        }
    },
    handleRead: function(read, timestamp) {
        for (var i = 0; i < read.length; ++i) {
            var ev = new Event('read');
            ev.timestamp = timestamp.toNumber();
            ev.read = {
              timestamp : read[i].timestamp.toNumber(),
              sender    : read[i].sender
            }
            this.dispatchEvent(ev);
        }
    },
    handleContacts: function(contacts) {
        console.log('contact sync');
        var eventTarget = this;
        var attachmentPointer = contacts.blob;
        return this.handleAttachment(attachmentPointer).then(function() {
            var contactBuffer = new ContactBuffer(attachmentPointer.data);
            var contactDetails = contactBuffer.next();
            while (contactDetails !== undefined) {
                var ev = new Event('contact');
                ev.contactDetails = contactDetails;
                eventTarget.dispatchEvent(ev);
                contactDetails = contactBuffer.next();
            }
            eventTarget.dispatchEvent(new Event('contactsync'));
        });
    },
    handleGroups: function(groups) {
        console.log('group sync');
        var eventTarget = this;
        var attachmentPointer = groups.blob;
        return this.handleAttachment(attachmentPointer).then(function() {
            var groupBuffer = new GroupBuffer(attachmentPointer.data);
            var groupDetails = groupBuffer.next();
            var promises = [];
            while (groupDetails !== undefined) {
                var promise = (function(groupDetails) {
                    groupDetails.id = groupDetails.id.toBinary();
                    if (groupDetails.active) {
                        return storage.groups.getGroup(groupDetails.id).
                            then(function(existingGroup) {
                                if (existingGroup === undefined) {
                                    return storage.groups.createNewGroup(
                                        groupDetails.members, groupDetails.id
                                    );
                                } else {
                                    return storage.groups.updateNumbers(
                                        groupDetails.id, groupDetails.members
                                    );
                                }
                            }).then(function() { return groupDetails });
                    } else {
                        return Promise.resolve(groupDetails);
                    }
                })(groupDetails).then(function(groupDetails) {
                    var ev = new Event('group');
                    ev.groupDetails = groupDetails;
                    eventTarget.dispatchEvent(ev);
                }).catch(function(e) {
                    console.log('error processing group', e);
                });
                groupDetails = groupBuffer.next();
                promises.push(promise);
            }
            Promise.all(promises).then(function() {
                eventTarget.dispatchEvent(new Event('groupsync'));
            });
        });
    },
    handleBlocked: function(blocked) {
        storage.put('blocked', blocked.numbers);
    },
    isBlocked: function(number) {
        return false; // XXX
        //return storage.get('blocked', []).indexOf(number) >= 0;
    },
    handleAttachment: function(attachment) {
        function decryptAttachment(encrypted) {
            return crypto.decryptAttachment(
                encrypted,
                attachment.key.toArrayBuffer()
            );
        }

        function updateAttachment(data) {
            attachment.data = data;
        }

        return this.server.getAttachment(attachment.id.toString()).
        then(decryptAttachment).
        then(updateAttachment);
    },
    tryMessageAgain: function(from, ciphertext) {
        var address = libsignal.SignalProtocolAddress.fromString(from);
        var sessionCipher = new libsignal.SessionCipher(storage.protocol, address);
        console.log('retrying prekey whisper message');
        return this.decryptPreKeyWhisperMessage(ciphertext, sessionCipher, address).then(function(plaintext) {
            var finalMessage = protobufs.DataMessage.decode(plaintext);

            var p = Promise.resolve();
            if ((finalMessage.flags & protobufs.DataMessage.Flags.END_SESSION)
                    == protobufs.DataMessage.Flags.END_SESSION &&
                    finalMessage.sync !== null) {
                    var number = address.getName();
                    p = this.handleEndSession(number);
            }

            return p.then(function() {
                return this.processDecrypted(finalMessage);
            }.bind(this));
        }.bind(this));
    },
    handleEndSession: function(number) {
        console.log('got end session');
        return storage.protocol.getDeviceIds(number).then(function(deviceIds) {
            return Promise.all(deviceIds.map(function(deviceId) {
                var address = new libsignal.SignalProtocolAddress(number, deviceId);
                var sessionCipher = new libsignal.SessionCipher(storage.protocol, address);

                console.log('closing session for', address.toString());
                return sessionCipher.closeOpenSessionForDevice();
            }));
        });
    },
    processDecrypted: function(decrypted, source) {
        // Now that its decrypted, validate the message and clean it up for consumer processing
        // Note that messages may (generally) only perform one action and we ignore remaining fields
        // after the first action.

        if (decrypted.flags == null) {
            decrypted.flags = 0;
        }
        if (decrypted.expireTimer == null) {
            decrypted.expireTimer = 0;
        }

        if (decrypted.flags & protobufs.DataMessage.Flags.END_SESSION) {
            decrypted.body = null;
            decrypted.attachments = [];
            decrypted.group = null;
            return Promise.resolve(decrypted);
        } else if (decrypted.flags & protobufs.DataMessage.Flags.EXPIRATION_TIMER_UPDATE ) {
            decrypted.body = null;
            decrypted.attachments = [];
        } else if (decrypted.flags != 0) {
            throw new Error("Unknown flags in message");
        }

        var promises = [];

        if (decrypted.group !== null) {
            decrypted.group.id = decrypted.group.id.toBinary();

            if (decrypted.group.type == protobufs.GroupContext.Type.UPDATE) {
                if (decrypted.group.avatar !== null) {
                    promises.push(this.handleAttachment(decrypted.group.avatar));
                }
            }

            promises.push(storage.groups.getNumbers(decrypted.group.id).then(function(existingGroup) {
                if (existingGroup === undefined) {
                    if (decrypted.group.type != protobufs.GroupContext.Type.UPDATE) {
                        decrypted.group.members = [source];
                        console.log("Got message for unknown group");
                    }
                    return storage.groups.createNewGroup(decrypted.group.members, decrypted.group.id);
                } else {
                    var fromIndex = existingGroup.indexOf(source);

                    if (fromIndex < 0) {
                        //TODO: This could be indication of a race...
                        console.log("Sender was not a member of the group they were sending from");
                    }

                    switch(decrypted.group.type) {
                    case protobufs.GroupContext.Type.UPDATE:
                        return storage.groups.updateNumbers(
                            decrypted.group.id, decrypted.group.members
                        ).then(function(added) {
                            decrypted.group.added = added;

                            if (decrypted.group.avatar === null &&
                                decrypted.group.added.length == 0 &&
                                decrypted.group.name === null) {
                                return;
                            }

                            decrypted.body = null;
                            decrypted.attachments = [];
                        });

                        break;
                    case protobufs.GroupContext.Type.QUIT:
                        decrypted.body = null;
                        decrypted.attachments = [];
                        if (source === this.number) {
                            return storage.groups.deleteGroup(decrypted.group.id);
                        } else {
                            return storage.groups.removeNumber(decrypted.group.id, source);
                        }
                    case protobufs.GroupContext.Type.DELIVER:
                        decrypted.group.name = null;
                        decrypted.group.members = [];
                        decrypted.group.avatar = null;

                        break;
                    default:
                        throw new Error("Unknown group message type");
                    }
                }
            }.bind(this)));
        }

        for (var i in decrypted.attachments) {
            promises.push(this.handleAttachment(decrypted.attachments[i]));
        }
        return Promise.all(promises).then(function() {
            return decrypted;
        });
    }
});

const _MessageReceiver = function(url, username, password, signalingKey, attachment_server_url) {
    var messageReceiver = new MessageReceiver(url, username, password, signalingKey, attachment_server_url);
    this.addEventListener    = messageReceiver.addEventListener.bind(messageReceiver);
    this.removeEventListener = messageReceiver.removeEventListener.bind(messageReceiver);
    this.getStatus           = messageReceiver.getStatus.bind(messageReceiver);
    this.close               = messageReceiver.close.bind(messageReceiver);
    messageReceiver.connect();

    errors.replay.registerFunction(messageReceiver.tryMessageAgain.bind(messageReceiver), errors.replay.Type.INIT_SESSION);
};

_MessageReceiver.prototype = {
    constructor: module.exports
};

module.exports = _MessageReceiver;