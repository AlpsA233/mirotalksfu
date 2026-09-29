'use strict';

// Shared by the pre-join preview and every in-meeting camera restart.
const CameraCapture = (() => {
    const resolutions = {
        qvga: [320, 240],
        vga: [640, 480],
        hd: [1280, 720],
        fhd: [1920, 1080],
        '2k': [2560, 1440],
        '4k': [3840, 2160],
        '6k': [6144, 3456],
        '8k': [7680, 4320],
    };
    const denied = (error) => ['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error.name);
    const stop = (stream) => stream?.getTracks().forEach((track) => track.stop());
    const bitrate = (settings, scale = 1) =>
        Math.round(
            Math.min(
                50000000,
                Math.max(
                    500000,
                    ((((settings.width || 1280) / scale) * (settings.height || 720)) / scale) *
                        (settings.frameRate || 30) *
                        0.1
                )
            )
        );

    async function acquire(
        { deviceId, facingMode, quality = 'default', fps = 30 } = {},
        devices = navigator.mediaDevices
    ) {
        const identity = facingMode
            ? { facingMode: { exact: facingMode } }
            : deviceId
              ? { deviceId: { exact: deviceId } }
              : {};
        const constraints = (size) => ({
            ...identity,
            frameRate: { ideal: fps },
            ...(size ? { width: { exact: size[0] }, height: { exact: size[1] } } : {}),
        });
        if (resolutions[quality])
            return devices.getUserMedia({ audio: false, video: constraints(resolutions[quality]) });

        let stream = await devices.getUserMedia({ audio: false, video: constraints() });
        let track = stream.getVideoTracks()[0];
        try {
            let caps = {};
            try {
                caps = track.getCapabilities?.() || {};
            } catch {
                /* Older browsers: use the resolution ladder. */
            }
            let best = track.getSettings();
            const area = (settings) => (settings.width || 0) * (settings.height || 0);
            const apply = async (video) => {
                if (track.applyConstraints && track.readyState !== 'ended') await track.applyConstraints(video);
                else {
                    stop(stream);
                    stream = await devices.getUserMedia({ audio: false, video });
                    track = stream.getVideoTracks()[0];
                }
                const actual = track.getSettings();
                if (area(actual) > area(best)) best = actual;
                return actual;
            };
            const attempt = async (video) => {
                try {
                    return await apply(video);
                } catch (error) {
                    if (denied(error)) throw error;
                    return null;
                }
            };
            if (caps.width?.max && caps.height?.max) {
                const maximum = [caps.width.max, caps.height.max];
                const actual = await attempt(constraints(maximum));
                if (actual?.width === maximum[0] && actual?.height === maximum[1]) return stream;
                // Range maxima need not describe a valid width/height pair. Probe
                // each dimension with the other flexible, retaining the largest area.
                await attempt({ ...constraints(), width: { exact: maximum[0] }, height: { ideal: maximum[1] } });
                await attempt({ ...constraints(), width: { ideal: maximum[0] }, height: { exact: maximum[1] } });
            }
            for (const size of Object.values(resolutions).reverse()) {
                if (size[0] * size[1] <= area(best)) continue;
                const actual = await attempt(constraints(size));
                if (actual?.width === size[0] && actual?.height === size[1]) break;
            }
            const actual = track.getSettings();
            if (track.readyState === 'ended' || area(actual) < area(best))
                await apply(constraints(best.width && best.height ? [best.width, best.height] : undefined));
            return stream;
        } catch (error) {
            stop(stream);
            throw error;
        }
    }

    function showStatus(quality, settings) {
        const node = document.getElementById('cameraCaptureStatus');
        if (node)
            node.textContent = `${quality === 'default' ? '自动最高' : '手动画质'} · ${settings?.width && settings?.height ? `实际 ${settings.width}×${settings.height}${settings.frameRate ? ` · ${Math.round(settings.frameRate * 10) / 10} fps` : ''}` : '下次开启时生效'}`;
    }

    return { acquire, resolutions, bitrate, showStatus, denied };
})();
if (typeof module !== 'undefined') module.exports = CameraCapture;
