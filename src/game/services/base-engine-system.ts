import {IEngineSystemsRegistry} from "./interfaces";

export interface IEngineSystem {
    create(): void

    init(registry: IEngineSystemsRegistry): void

    start(): void;

    update(dt: number): void;
}

export class EngineSystem implements IEngineSystem {
    create() {
    }

    init(registry: IEngineSystemsRegistry) {
    }

    start() {
    }

    update() {
    }

}