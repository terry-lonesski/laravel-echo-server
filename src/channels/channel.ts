let fs = require('fs');
let request = require('request');
import {PresenceChannel} from './presence-channel';
import {PrivateChannel} from './private-channel';
import {Log} from './../log';
import {Database} from "../database";

export class Channel {
    /**
     * Database instance.
     */
    db: Database;
    /**
     * Channels and patters for private channels.
     */
    protected _privateChannels: string[] = ['private-*', 'presence-*'];

    /**
     * Allowed client events
     */
    protected _clientEvents: string[] = ['client-*'];

    /**
     * Private channel instance.
     */
    private: PrivateChannel;

    /**
     * Presence channel instance.
     */
    presence: PresenceChannel;

    /**
     * Request client.
     *
     * @type {any}
     */
    private request: any;

    /**
     * Create a new channel instance.
     */
    constructor(private io, private options) {
        this.private = new PrivateChannel(options);
        this.presence = new PresenceChannel(io, options);
        this.request = request;
        this.db = new Database(options);

        if (this.options.devMode) {
            Log.success('Channels are ready.');
        }
    }

    /**
     * Get the members of a presence channel.
     */
    getMembers(channel: string): Promise<any> {
        return this.db.get(channel + ":members");
    }

    /**
     * Join a channel.
     */
    join(socket, data): void {
        if (data.channel) {
            if (this.isPrivate(data.channel)) {
                this.joinPrivate(socket, data);
            } else {
                this.onJoin(socket, data.channel);
                socket.join(data.channel);

                if (socket.userId) {
                    this.getMembers(data.channel).then(
                        (members) => {
                            const member = {
                                userId: socket.userId,
                                socketId: socket.id
                            }

                            this.removeInactive(data.channel, members, member).then(members => {
                                members.push(member);
                                this.db.set(data.channel + ":members", members);
                                this.db.set(data.channel + ":members-count", members.length);
                            })
                        },
                        (error) => Log.error(error)
                    );
                }
            }
        }
    }

    /**
     * Remove inactive channel members from the presence channel.
     */
    removeInactive(channel: string, members: any[], member): Promise<any> {
        return new Promise((resolve, reject) => {
            this.io
                .of("/")
                .in(channel)
                .clients((error, clients) => {
                    let list = members || [];
                    list = list.filter((m) => {
                        return clients.indexOf(m.socketId) >= 0 && m.userId != member.userId;
                    });

                    resolve(list);
                });
        });
    }

    /**
     * Trigger a client message
     */
    clientEvent(socket, data): void {
        try {
            data = JSON.parse(data);
        } catch (e) {
            data = data;
        }

        if (data.event && data.channel) {
            if (this.isClientEvent(data.event) &&
                this.isPrivate(data.channel) &&
                this.isInChannel(socket, data.channel)) {
                this.io.sockets.connected[socket.id]
                    .broadcast.to(data.channel)
                    .emit(data.event, data.channel, data.data);
            }
        }
    }

    /**
     * Prepare headers for request to app server.
     *
     * @param {any} socket
     * @param {string} channel
     * @param {string} hookEndpoint
     * @param {string} event
     * @returns {any}
     */
    prepareHookHeaders(socket: any, channel: string, hookEndpoint: string, event: string): any {
        let hookHost = this.options.hookHost ? this.options.hookHost : this.options.authHost;
        let options = {
            url: hookHost + hookEndpoint,
            form: {
                userId: socket.userId,
                event: event,
                channel: channel,
            },
            headers: {}
        };

        options.headers['Cookie'] = socket.request.headers.cookie;
        options.headers['X-Requested-With'] = 'XMLHttpRequest';
        return options;
    }

    /**
     * Leave a channel.
     */
    leave(socket: any, channel: string, reason: string): void {
        if (channel) {
            if (this.isPresence(channel)) {
                this.presence.leave(socket, channel)
            } else {
                this.getMembers(channel).then(
                    (members) => {
                        members = members || [];
                        let member = members.find(
                            (member) => member.socketId == socket.id
                        );
                        members = members.filter((m) => m.socketId != socket.id);

                        this.db.set(channel + ":members", members);
                        this.db.set(channel + ":members-count", members.length);
                    },
                    (error) => Log.error(error)
                );
            }

            socket.leave(channel);

            if (this.options.hookEndpoint) {
                this.sendHook(socket, channel, 'leave');
            }

            if (this.options.devMode) {
                Log.info(`[${new Date().toISOString()}] - ${socket.id} left channel: ${channel} (${reason})`);
            }
        }
    }

    sendHook(socket: any, channel: string, event: string) {
        let hookEndpoint = this.options.hookEndpoint;
        let options = this.prepareHookHeaders(socket, channel, hookEndpoint, event);

        this.request.post(options, (error, response, body, next) => {
            if (error) {
                if (this.options.devMode) {
                    Log.error(`[${new Date().toLocaleTimeString()}] - Error call ${event} hook ${socket.id} for ${options.form.channel}`);
                }
                Log.error(error);
            } else if (response.statusCode !== 200) {
                if (this.options.devMode) {
                    Log.warning(`[${new Date().toLocaleTimeString()}] - Error call ${event} hook ${socket.id} for ${options.form.channel}`);
                    Log.error(response.body);
                }
            } else {
                if (this.options.devMode) {
                    Log.info(`[${new Date().toLocaleTimeString()}] - Call ${event} hook for ${socket.id} for ${options.form.channel}: ${response.body}`);
                }
            }
        });
    }

    /**
     * Check if the incoming socket connection is a private channel.
     */
    isPrivate(channel: string): boolean {
        let isPrivate = false;

        this._privateChannels.forEach(privateChannel => {
            let regex = new RegExp(privateChannel.replace('\*', '.*'));
            if (regex.test(channel)) isPrivate = true;
        });

        return isPrivate;
    }

    /**
     * Join private channel, emit data to presence channels.
     */
    joinPrivate(socket: any, data: any): void {
        this.private.authenticate(socket, data).then(res => {
            socket.join(data.channel);

            if (this.isPresence(data.channel)) {
                var member = res.channel_data;
                try {
                    member = JSON.parse(res.channel_data);
                } catch (e) {
                }

                this.presence.join(socket, data.channel, member);
            }

            this.onJoin(socket, data.channel);
        }, error => {
            if (this.options.devMode) {
                Log.error(error.reason);
            }

            this.io.sockets.to(socket.id)
                .emit('subscription_error', data.channel, error.status);
        });
    }

    /**
     * Check if a channel is a presence channel.
     */
    isPresence(channel: string): boolean {
        return channel.lastIndexOf('presence-', 0) === 0;
    }

    /**
     * On join a channel log success.
     */
    onJoin(socket: any, channel: string): void {
        const match = channel.match(/user.(\d*)/);
        if (match && match[1]) {
            socket.userId = match[1];
        }

        if (this.options.devMode) {
            Log.info(`[${new Date().toISOString()}] - ${socket.id} joined channel: ${channel}`);
        }
    }

    /**
     * Check if client is a client event
     */
    isClientEvent(event: string): boolean {
        let isClientEvent = false;

        this._clientEvents.forEach(clientEvent => {
            let regex = new RegExp(clientEvent.replace('\*', '.*'));
            if (regex.test(event)) isClientEvent = true;
        });

        return isClientEvent;
    }

    /**
     * Check if a socket has joined a channel.
     */
    isInChannel(socket: any, channel: string): boolean {
        return !!socket.rooms[channel];
    }
}
