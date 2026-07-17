import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const LOGISTICS_API_BASE_URL =
  process.env.LOGISTICS_API_BASE_URL ?? "http://127.0.0.1:8200";
const LOGISTICS_API_TIMEOUT_MS = Number(process.env.LOGISTICS_API_TIMEOUT_MS ?? 5000);

/**
 * 订单物流查询工具。
 *
 * 真实实现：通过 HTTP 调用 customer-logistics-api（暂未实现，后续会补一个 mock 接口，
 * 契约见下方注释）。这里不编造任何物流结果——查询失败/超时/订单不存在时，都如实返回
 * found: false 加上具体原因，让 agent 按 instructions 的规则向用户说明，而不是瞎编状态。
 *
 * 约定的 HTTP 契约（customer-logistics-api 需要实现这个接口）：
 *   GET {LOGISTICS_API_BASE_URL}/orders/{orderId}/logistics
 *   200 -> { orderId, status, lastLocation, lastUpdatedAt, courier, trackingNumber }
 *   404 -> 订单不存在
 *   其他非 2xx -> 视为查询异常
 */
export const logisticsLookupTool = createTool({
  id: "logistics-lookup-tool",
  description:
    "根据订单号查询该订单当前的物流状态、最新节点和承运信息。仅在用户已提供订单号且询问物流、" +
    "快递、签收、派送、催件时调用；不要用于库存、价格、退款进度等其他实时信息查询。",
  inputSchema: z.object({
    orderId: z.string().describe("订单号"),
  }),
  outputSchema: z.object({
    found: z.boolean().describe("是否查询到该订单的物流信息"),
    status: z.string().optional().describe("物流状态，例如 in_transit / delivered / exception"),
    lastLocation: z.string().optional().describe("最新物流节点所在位置"),
    lastUpdatedAt: z.string().optional().describe("最新物流节点更新时间"),
    courier: z.string().optional().describe("承运快递公司"),
    trackingNumber: z.string().optional().describe("运单号"),
    message: z.string().describe("查询结果说明，查询失败时说明具体原因"),
  }),
  execute: async ({ orderId }) => {
    const url = `${LOGISTICS_API_BASE_URL}/orders/${encodeURIComponent(orderId)}/logistics`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOGISTICS_API_TIMEOUT_MS);

    try {
      const response = await fetch(url, { signal: controller.signal });

      if (response.status === 404) {
        return {
          found: false,
          message: `未查询到订单号 ${orderId} 对应的物流信息，请确认订单号是否正确。`,
        };
      }

      if (!response.ok) {
        return {
          found: false,
          message: `物流查询服务返回异常状态码 ${response.status}，建议稍后重试或转人工核实。`,
        };
      }

      const data = (await response.json()) as {
        status?: string;
        lastLocation?: string;
        lastUpdatedAt?: string;
        courier?: string;
        trackingNumber?: string;
      };

      return {
        found: true,
        status: data.status,
        lastLocation: data.lastLocation,
        lastUpdatedAt: data.lastUpdatedAt,
        courier: data.courier,
        trackingNumber: data.trackingNumber,
        message: "查询成功。",
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        found: false,
        message: `物流查询服务暂时无法访问（${reason}），建议稍后重试或转人工核实，不要编造物流状态。`,
      };
    } finally {
      clearTimeout(timeout);
    }
  },
});
