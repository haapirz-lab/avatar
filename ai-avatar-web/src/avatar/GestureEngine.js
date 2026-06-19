import * as THREE from 'three';

/**
 * GestureEngine — controls the avatar's BODY (arms, head, torso).
 *
 * AI sends:  gesture: "wave"  ->  gesture.play("wave")
 *
 * Gestures are procedural: each one computes euler-angle OFFSETS for a set of
 * humanoid bones as a function of elapsed time. Offsets are smoothed toward
 * their targets and applied on top of each bone's rest pose, so gestures blend
 * naturally and always settle back to idle.
 */
const BONES = [
    'rightUpperArm', 'rightLowerArm',
    'leftUpperArm', 'leftLowerArm',
    'head', 'neck', 'spine', 'chest',
];

export class GestureEngine {
    constructor(vrm) {
        this.vrm = vrm;
        this.gesture = 'idle';
        this.elapsed = 0;
        this.duration = 0;        // 0 = run until replaced (idle)

        this.base = {};           // bone -> rest quaternion
        this.offset = {};         // bone -> current euler offset (smoothed)
        this.nodes = {};

        const humanoid = vrm && vrm.humanoid;
        BONES.forEach((name) => {
            const node = humanoid ? humanoid.getNormalizedBoneNode(name) : null;
            this.nodes[name] = node || null;
            if (node) this.base[name] = node.quaternion.clone();
            this.offset[name] = new THREE.Euler(0, 0, 0);
        });
    }

    play(gesture) {
        this.gesture = gesture || 'idle';
        this.elapsed = 0;
        this.duration = this.gesture === 'idle' ? 0 : 2.2;
    }

    /** Per-gesture target offsets (radians). Returns {bone: [x,y,z]}. */
    _poseFor(g, t) {
        const sin = Math.sin;
        const cos = Math.cos;
        switch (g) {
            case 'wave': {
                const s = sin(t * 8) * 0.5;
                const s2 = sin(t * 4) * 0.1;
                return {
                    rightUpperArm: [0.1, s2, -1.3],
                    rightLowerArm: [0, 0, -0.5 + s],
                    head: [0.05, sin(t * 2) * 0.1, 0],
                };
            }
            case 'nod': {
                const s = sin(t * 5) * 0.2;
                return { 
                    head: [s + 0.1, 0, 0], 
                    neck: [s * 0.5, 0, 0],
                    spine: [s * 0.2, 0, 0],
                };
            }
            case 'shake': {
                const s = sin(t * 6) * 0.3;
                return { 
                    head: [0, s, sin(t * 3) * 0.05], 
                    neck: [0, s * 0.5, 0] 
                };
            }
            case 'explain': {
                const s = sin(t * 3) * 0.3;
                const s2 = sin(t * 2.5) * 0.15;
                return {
                    rightUpperArm: [0.1, s2, -0.6 - s * 0.4],
                    rightLowerArm: [0, s * 0.5, -0.8],
                    leftUpperArm: [-0.1, -s2, 0.6 + s * 0.4],
                    leftLowerArm: [0, -s * 0.5, 0.8],
                    chest: [s * 0.1, 0, 0],
                    head: [0.05, sin(t * 2) * 0.08, 0],
                };
            }
            case 'think': {
                const s = sin(t * 2) * 0.05;
                return {
                    rightUpperArm: [0.3, 0, -0.9],
                    rightLowerArm: [0.3, 0, -1.6],
                    head: [0.1 + s, 0.2, 0.05],
                    leftUpperArm: [-0.1, 0, 0.3],
                    leftLowerArm: [0, 0, 0.5],
                };
            }
            case 'shrug': {
                const s = (sin(t * 2) + 1) * 0.5;
                return {
                    rightUpperArm: [0, 0, -0.3 - s * 0.3],
                    leftUpperArm: [0, 0, 0.3 + s * 0.3],
                    rightLowerArm: [0, 0, -1.0],
                    leftLowerArm: [0, 0, 1.0],
                    head: [0.1 + sin(t * 3) * 0.05, 0, 0],
                    shoulders: [0, s * 0.1, 0],
                };
            }
            case 'happy': {
                const s = sin(t * 4) * 0.1;
                return {
                    head: [0.05, s, 0],
                    rightUpperArm: [0.1, 0, -0.4],
                    leftUpperArm: [-0.1, 0, 0.4],
                    chest: [s * 0.1, 0, 0],
                };
            }
            case 'listening': {
                const s = sin(t * 1.5) * 0.08;
                return {
                    head: [0.05, 0, sin(t * 2) * 0.1],
                    neck: [s * 0.5, 0, 0],
                    rightUpperArm: [0.05, 0, -0.3],
                    leftUpperArm: [-0.05, 0, 0.3],
                };
            }
            default:
                return {};
        }
    }

    update(delta) {
        const dt = delta || 0.016;
        this.elapsed += dt;

        // Gestures auto-expire back to idle.
        let active = this.gesture;
        if (active !== 'idle' && this.duration > 0 && this.elapsed > this.duration) {
            active = 'idle';
        }

        const t = this.elapsed;
        const desired = this._poseFor(active, t);

        // Idle adds a subtle breathing sway and natural micro-movements always.
        // The arm values bring the upper arms DOWN to the sides so the avatar
        // rests in a natural pose instead of the VRM default T-pose. (A VRM's
        // rest pose has arms straight out; ~1.15 rad on Z lowers them.)
        const breathe = Math.sin(t * 1.6) * 0.03;
        const microHead = Math.sin(t * 2.3) * 0.02;
        const microShoulder = Math.sin(t * 1.8 + 0.5) * 0.015;
        const ARM_DOWN = 1.25;   // how far to drop the upper arms from T-pose
        const idle = {
            chest: [breathe, 0, 0],
            spine: [breathe * 0.6, 0, 0],
            head: [microHead, 0, Math.sin(t * 1.9) * 0.015],
            rightUpperArm: [0.05, microShoulder * 0.3,  ARM_DOWN],
            leftUpperArm:  [0.05, -microShoulder * 0.3, -ARM_DOWN],
            rightLowerArm: [0, 0,  0.18],   // slight, natural elbow bend
            leftLowerArm:  [0, 0, -0.18],
        };

        const speed = 8;
        BONES.forEach((name) => {
            const node = this.nodes[name];
            if (!node) return;
            const d = desired[name] || idle[name] || [0, 0, 0];
            const o = this.offset[name];
            o.x += (d[0] - o.x) * Math.min(1, dt * speed);
            o.y += (d[1] - o.y) * Math.min(1, dt * speed);
            o.z += (d[2] - o.z) * Math.min(1, dt * speed);

            const q = new THREE.Quaternion().setFromEuler(o);
            node.quaternion.copy(this.base[name]).multiply(q);
        });
    }
}
