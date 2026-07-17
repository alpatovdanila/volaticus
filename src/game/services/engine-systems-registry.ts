import {IEngineSystemsRegistry} from "./interfaces";
import {IEngineSystem} from "./base-engine-system";

export class EngineSystemsRegistry implements IEngineSystemsRegistry {
    private systems = new Map<string, IEngineSystem>();

    register(name: string, system: IEngineSystem): void {
        this.systems.set(name, system);
    }

    get<T>(name: string): T {
        const system = this.systems.get(name);
        if (!system) throw new Error(`System ${name} not found!`);
        return system as unknown as T;
    }

    async start() {
        // Phase 1: Allocate memory and Three.js objects for all systems
        for (const system of this.systems.values()) system.create()

        // Phase 2: Inter-link systems safely (Direct References)
        for (const system of this.systems.values())  system.init(this);

        for (const system of this.systems.values())  void system.start();
    }

    private tick(): void {
        // const clock = new THREE.Clock();
        //
        // const loop = () => {
        //     requestAnimationFrame(loop);
        //     const delta = clock.getDelta();
        //
        //     // // Strict execution order enforced manually here
        //     // this.get<IEngineSystem>('PhysicsSystem').update(delta);
        //     // this.get<IEngineSystem>('AudioSystem').update(delta);
        //     // this.get<IEngineSystem>('RenderSystem').update(delta);
        // };
        //
        // loop();
    }
}
