import {EngineSystem} from "./base-engine-system";
import {EventEmitter} from "../lib/event-emitter";

export class Input extends EngineSystem{
    private emitter = new EventEmitter()
}