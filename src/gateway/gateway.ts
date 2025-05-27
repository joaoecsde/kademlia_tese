export interface IGatewayInfo {
  blockchainId: string;
  nodeId: number;
  endpoint: string;
  supportedProtocols: string[];
  timestamp: number;
  version: number;
}

export class GatewayInfo implements IGatewayInfo {
  blockchainId: string;
  nodeId: number;
  endpoint: string;
  supportedProtocols: string[];
  timestamp: number;
  version: number;

  constructor(
    blockchainId: string,
    nodeId: number,
    endpoint: string,
    supportedProtocols: string[] = ['SATP']
  ) {
    this.blockchainId = blockchainId;
    this.nodeId = nodeId;
    this.endpoint = endpoint;
    this.supportedProtocols = supportedProtocols;
    this.timestamp = Date.now();
    this.version = 1;
  }

  serialize(): string {
    return JSON.stringify(this);
  }

  static deserialize(data: string): GatewayInfo {
    const parsed: IGatewayInfo = JSON.parse(data);
    const gateway = new GatewayInfo(
      parsed.blockchainId,
      parsed.nodeId,
      parsed.endpoint,
      parsed.supportedProtocols
    );
    gateway.timestamp = parsed.timestamp;
    gateway.version = parsed.version;
    return gateway;
  }
}