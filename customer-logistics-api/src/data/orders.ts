export interface OrderRecord {
  orderId: string;
  productName: string;
  orderStatus: "pending" | "shipped" | "delivered" | "cancelled";
  createdAt: string;
}

export interface LogisticsRecord {
  orderId: string;
  status: "pending" | "in_transit" | "delivered" | "exception";
  lastLocation: string | null;
  lastUpdatedAt: string | null;
  courier: string | null;
  trackingNumber: string | null;
}

// mock 数据，orderId 跟 QLoRA 训练数据里用的示例订单号风格保持一致，方便联调时对上。
export const orders: Record<string, OrderRecord> = {
  OD202607170099: {
    orderId: "OD202607170099",
    productName: "无线蓝牙耳机",
    orderStatus: "shipped",
    createdAt: "2026-07-17T09:00:00+08:00",
  },
  OD202607170345: {
    orderId: "OD202607170345",
    productName: "保温杯 500ml",
    orderStatus: "delivered",
    createdAt: "2026-07-15T14:30:00+08:00",
  },
  OD202607171201: {
    orderId: "OD202607171201",
    productName: "羽绒服",
    orderStatus: "pending",
    createdAt: "2026-07-17T20:10:00+08:00",
  },
  OD202607170520: {
    orderId: "OD202607170520",
    productName: "行李箱 20寸",
    orderStatus: "shipped",
    createdAt: "2026-07-10T11:00:00+08:00",
  },
  OD202607170890: {
    orderId: "OD202607170890",
    productName: "空气炸锅",
    orderStatus: "cancelled",
    createdAt: "2026-07-12T08:00:00+08:00",
  },
};

export const logistics: Record<string, LogisticsRecord> = {
  OD202607170099: {
    orderId: "OD202607170099",
    status: "in_transit",
    lastLocation: "上海转运中心",
    lastUpdatedAt: "2026-07-17T18:20:00+08:00",
    courier: "顺丰速运",
    trackingNumber: "SF1234567890123",
  },
  OD202607170345: {
    orderId: "OD202607170345",
    status: "delivered",
    lastLocation: "北京市朝阳区（已签收）",
    lastUpdatedAt: "2026-07-16T10:05:00+08:00",
    courier: "圆通速递",
    trackingNumber: "YT9876543210987",
  },
  OD202607171201: {
    orderId: "OD202607171201",
    status: "pending",
    lastLocation: null,
    lastUpdatedAt: null,
    courier: null,
    trackingNumber: null,
  },
  OD202607170520: {
    orderId: "OD202607170520",
    status: "exception",
    lastLocation: "广州转运中心（3天无更新）",
    lastUpdatedAt: "2026-07-14T09:00:00+08:00",
    courier: "中通快递",
    trackingNumber: "ZTO5566778899001",
  },
  // OD202607170890（cancelled 订单）故意不给物流记录，用来测试订单存在但查不到物流的情况。
};
