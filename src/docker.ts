import Docker from 'dockerode';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { CONFIG } from './utils.js';

const docker = CONFIG.DOCKER_ENABLED ? new Docker() : null;

export interface ContainerInfo {
  id: string;
  port: number;
  hostPort: number;
}

export async function isDockerAvailable(): Promise<boolean> {
  if (!docker) return false;
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

function detectBaseImage(projectPath: string): { image: string; user?: string } {
  if (existsSync(join(projectPath, 'pubspec.yaml'))) {
    return { image: 'cirrusci/flutter:stable' };
  }
  if (existsSync(join(projectPath, 'requirements.txt')) || existsSync(join(projectPath, 'pyproject.toml'))) {
    return { image: 'python:3.11-slim', user: 'nobody' };
  }
  return { image: 'node:18-alpine', user: 'node' };
}

export async function startContainer(
  projectPath: string,
  command: string,
  hostPort: number,
  env: Record<string, string> = {}
): Promise<ContainerInfo> {
  if (!docker) throw new Error('Docker not enabled or not available');

  const { image: baseImage, user } = detectBaseImage(projectPath);
  const containerPort = 3000;

  try {
    await docker.getImage(baseImage).inspect();
  } catch {
    await new Promise<void>((resolve, reject) => {
      docker!.pull(baseImage, (err: any, stream: any) => {
        if (err) return reject(err);
        docker!.modem.followProgress(stream, (err2: any) => (err2 ? reject(err2) : resolve()));
      });
    });
  }

  const argv = command.trim().split(/\s+/).filter(Boolean);
  if (argv.length === 0) throw new Error('Empty command for container');

  const envList = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  envList.push(`PORT=${containerPort}`);
  envList.push('HOST=0.0.0.0');

  const hostConfig: any = {
    Binds: [`${projectPath}:/app:rw`],
    PortBindings: {
      [`${containerPort}/tcp`]: [{ HostPort: String(hostPort) }],
    },
    AutoRemove: true,
    Memory: 512 * 1024 * 1024,
    NanoCpus: 1e9,
    SecurityOpt: ['no-new-privileges:true'],
    CapDrop: ['ALL'],
    NetworkMode: 'bridge',
  };

  const createOpts: any = {
    Image: baseImage,
    Cmd: argv,
    WorkingDir: '/app',
    Env: envList,
    HostConfig: hostConfig,
    ExposedPorts: {
      [`${containerPort}/tcp`]: {},
    },
  };
  if (user) createOpts.User = user;

  const container = await docker.createContainer(createOpts);
  await container.start();
  return { id: container.id, port: containerPort, hostPort };
}

export async function stopContainer(containerId: string): Promise<void> {
  if (!docker) return;
  try {
    const c = docker.getContainer(containerId);
    await c.stop({ t: 5 });
  } catch {
    try {
      const c = docker.getContainer(containerId);
      await c.remove({ force: true });
    } catch {}
  }
}

export async function getContainerLogs(containerId: string): Promise<string> {
  if (!docker) return '';
  try {
    const c = docker.getContainer(containerId);
    const stream = await c.logs({ stdout: true, stderr: true, tail: 100, follow: false });
    return Buffer.isBuffer(stream) ? stream.toString() : String(stream);
  } catch {
    return '';
  }
}

export async function reapOrphanContainers(label = 'live-preview-mcp'): Promise<number> {
  if (!docker) return 0;
  try {
    const list = await docker.listContainers({ all: true, filters: { label: [label] } });
    let killed = 0;
    for (const info of list) {
      try {
        const c = docker.getContainer(info.Id);
        if (info.State === 'running') await c.stop({ t: 2 });
        await c.remove({ force: true });
        killed++;
      } catch {}
    }
    return killed;
  } catch {
    return 0;
  }
}
