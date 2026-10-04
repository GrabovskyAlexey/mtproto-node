import Docker from 'dockerode';
import { config } from '../config';
import * as store from '../store';
import { createVpnStatusChecker } from './vpn-status';
import { probeSocksTunnel } from './socks-probe';

const docker = new Docker({ socketPath: '/var/run/docker.sock', timeout: 5_000 });
const checker = createVpnStatusChecker({
  inspect: async (name: string) => {
    const info = await docker.getContainer(name).inspect();
    return {
      running: info.State.Running && !info.State.Paused,
      identity: `${info.Id}:${info.State.StartedAt}`,
    };
  },
  probe: async (name: string) => { await probeSocksTunnel(name); },
});

// Read the stored configuration; never probe arbitrary hosts from API input.
export async function withVpnStatus<T extends { id: string }>(value: T) {
  const proxy = store.getProxyById(value.id);
  const configured = Boolean(proxy?.vpnSubscription || proxy?.vpnContainerName);
  const expectedName = proxy ? `${config.xrayContainerPrefix}${proxy.id}` : undefined;
  const name = proxy?.vpnContainerName === expectedName ? expectedName : undefined;
  return { ...value, vpnStatus: await checker.check(name, configured) };
}
