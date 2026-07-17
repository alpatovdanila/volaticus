import {IEngineSystem} from "./base-engine-system";

export interface IEngineSystemsRegistry {
    get<T>(systemName: string): T;
    register(systemName: string, systemInstance:IEngineSystem): void
}

// These are types — re-export with `export type`, or the ESM runtime treats them as value
// imports and throws "does not provide an export named ..." (types are erased in the JS).
export type {IDeviceScreen} from './device-screen'
export type {IRenderer} from './renderer'
export type {IInventory, InventoryType} from './inventory'
export {INVENTORY_TYPE} from './inventory' // a value (const object) — a real runtime export
export type {ILevels} from './levels/levels'