import { Registry } from '../lib/registry'

export class UserRegistry extends Registry<{ render: { antialias: boolean; pixelRatio: number } }> {
  data = {
    render: {
      antialias: true,
      pixelRatio: 1,
    },
  }
}

export const userRegistry = new UserRegistry()
