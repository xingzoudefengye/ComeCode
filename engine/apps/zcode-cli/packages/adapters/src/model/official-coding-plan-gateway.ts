// Modified by ComeCode：默认直连用户配置地址，不将官方端点改写到厂商网关。
import type { EnvRecord } from "./model-execution.js";

export interface OfficialCodingPlanGatewayRoute {
  /** 官方模型端点（含路径），仅 https。 */
  readonly providerEndpoint: string;
  /** 历史网关路径，仅为兼容现有路由表保留；CLI 不再使用它。 */
  readonly gatewayPath: string;
}

export const OFFICIAL_CODING_PLAN_GATEWAY_ROUTES: readonly OfficialCodingPlanGatewayRoute[] = [
  {
    providerEndpoint: "https://open.bigmodel.cn/api/anthropic/v1/messages",
    gatewayPath: "/api/v1/ultra/anthropic/v1/messages",
  },
  {
    providerEndpoint: "https://api.z.ai/api/anthropic/v1/messages",
    gatewayPath: "/api/v1/ultra-zai/anthropic/v1/messages",
  },
];

export interface OfficialCodingPlanGatewayDecision {
  /** 是否改写到平台网关；ComeCode CLI 始终为 false。 */
  readonly viaGateway: boolean;
  /** 实际发送的 URL；未命中时与入参一致。 */
  readonly url: string;
}

export type OfficialCodingPlanGatewayFetch = typeof globalThis.fetch;

export function resolveOfficialCodingPlanGatewayUrl(
  requestUrl: string,
  _env: EnvRecord = process.env,
): OfficialCodingPlanGatewayDecision {
  return { viaGateway: false, url: requestUrl };
}

export function createOfficialCodingPlanGatewayFetch(options: {
  env?: EnvRecord;
  fetch: OfficialCodingPlanGatewayFetch;
}): OfficialCodingPlanGatewayFetch {
  return options.fetch;
}
