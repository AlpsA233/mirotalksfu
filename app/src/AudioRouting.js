'use strict';

// Managed microphone audio has two independent destinations: the recorder and
// meeting listeners. Never pause its Producer just to silence the meeting.
const pending = new WeakMap();

function isManagedMicrophone(producer) {
    return producer?.kind === 'audio' && producer.appData?.audioMode !== undefined;
}

function isAudible(producer) {
    return !isManagedMicrophone(producer) || producer.appData.audioMode === 'live';
}

function assertAudible(producer) {
    if (isAudible(producer)) return;
    const error = new Error('This microphone is available to the recorder only');
    error.code = 'AUDIO_NOT_LIVE';
    error.retryable = false;
    throw error;
}

function publishMode(room, peer, producer, mode = producer.appData.audioMode) {
    peer.peer_info.peer_audio_mode = mode;
    peer.peer_info.peer_audio_capture = mode !== 'off';
    peer.peer_info.peer_audio = peer.peer_audio = mode === 'live';
    peer.audioModeRevision = (peer.audioModeRevision || 0) + 1;
    const state = {
        peer_id: peer.id,
        producer_id: producer.id,
        mode,
        revision: peer.audioModeRevision,
    };
    room.sendToAll('audioModeChanged', state);
    room.broadCast(peer.id, 'updatePeerInfo', {
        peer_id: peer.id,
        peer_name: peer.peer_name,
        type: 'audio',
        status: mode === 'live',
    });
    return state;
}

function closeListeners(room, producerId) {
    for (const peer of room.peers.values()) {
        for (const consumer of peer.consumers.values()) {
            if (consumer.producerId !== producerId) continue;
            peer.removeConsumer(consumer.id);
            room.send(peer.id, 'consumerClosed', { consumer_id: consumer.id, consumer_kind: consumer.kind });
        }
    }
}

async function updateObservers(room, producer, audible) {
    await Promise.all(
        [room.audioLevelObserver, room.activeSpeakerObserver].map(async (observer) => {
            if (!observer || observer.closed) return;
            try {
                await observer[audible ? 'addProducer' : 'removeProducer']({ producerId: producer.id });
            } catch {
                // Observer lifetime may race a room/producer closing. Routing
                // and recording do not depend on speaker detection succeeding.
            }
        })
    );
}

function setMode(room, peer, producer, mode) {
    const operation = (pending.get(producer) || Promise.resolve())
        .catch(() => {})
        .then(async () => {
            if (!['record_only', 'live'].includes(mode)) throw new Error('Invalid audio mode');
            if (!isManagedMicrophone(producer) || producer.closed || peer.getProducer(producer.id) !== producer) {
                throw new Error('Managed microphone not found');
            }
            if (
                mode === 'live' &&
                !peer.peer_info.peer_presenter &&
                (room._moderator?.audio_cant_unmute || room._isBroadcasting)
            ) {
                throw new Error('The moderator does not allow you to speak');
            }
            if (producer.appData.audioMode === mode) {
                return { peer_id: peer.id, producer_id: producer.id, mode, revision: peer.audioModeRevision || 0 };
            }

            // Revoke access before any asynchronous work. In-flight consumers are
            // checked again by Room.consume/resumeConsumer before they can deliver RTP.
            producer.appData.audioMode = mode;
            if (mode === 'record_only') closeListeners(room, producer.id);
            await updateObservers(room, producer, mode === 'live');
            if (producer.closed || peer.getProducer(producer.id) !== producer) throw new Error('Microphone closed');
            const state = publishMode(room, peer, producer);
            if (mode === 'live') {
                room.broadCast(peer.id, 'newProducers', [
                    {
                        producer_id: producer.id,
                        producer_socket_id: peer.id,
                        peer_name: peer.peer_name,
                        peer_info: peer.peer_info,
                        type: producer.appData.mediaType,
                    },
                ]);
            }
            return state;
        });
    pending.set(producer, operation);
    return operation;
}

module.exports = { isManagedMicrophone, isAudible, assertAudible, publishMode, setMode };
