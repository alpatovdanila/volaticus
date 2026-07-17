import * as THREE from 'three'
import {IDeviceScreen, IEngineSystemsRegistry} from "./interfaces";
import {EngineSystem} from "./base-engine-system";

export class CameraManager extends EngineSystem {
    private deviceScreen: IDeviceScreen | null = null;

    init(r: IEngineSystemsRegistry): void {
        this.deviceScreen = r.get<IDeviceScreen>("deviceScreen");
    }

    createCamera(): THREE.PerspectiveCamera {
        const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 200);
        this.deviceScreen?.onAspectRatioChanged((aspectRatio) => {
            camera.aspect = aspectRatio;
            camera.updateProjectionMatrix();
        });
        return camera;
    }
}

export type ICameraManager = InstanceType<typeof CameraManager>
