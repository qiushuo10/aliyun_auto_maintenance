/// <reference types="vite/client" />

import type { AliyAgentApi } from '../../preload';

declare global {
  interface Window {
    aliyAgent: AliyAgentApi;
  }
}
