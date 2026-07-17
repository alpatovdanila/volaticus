import {EngineSystem} from "../services/base-engine-system";

export class Registry<T> extends EngineSystem {
  public data: T = {} as T
}
