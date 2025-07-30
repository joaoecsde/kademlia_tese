export interface IGatewayInfo {
  blockchainId: string;
  nodeId: number;
  endpoint: string;
  timestamp: number;
  pubKey?: string;
  chainId?: number;
  isHealthy?: boolean;
  lastHealthCheck?: number;
}

export class GatewayInfo implements IGatewayInfo {
  blockchainId: string;
  nodeId: number;
  endpoint: string;
  timestamp: number;
  pubKey?: string;
  chainId?: number;
  isHealthy?: boolean;
  lastHealthCheck?: number;

  constructor(
    blockchainId: string,
    nodeId: number,
    endpoint: string,
    pubKey?: string
  ) {
    this.blockchainId = blockchainId;
    this.nodeId = nodeId;
    this.endpoint = this.validateAndNormalizeEndpoint(endpoint);
    this.pubKey = pubKey;
    this.timestamp = Date.now();
  }

  private validateAndNormalizeEndpoint(endpoint: string): string {
    try {
      const url = new URL(endpoint);
      // Ensure it's http or https
      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Endpoint must use http or https protocol');
      }
      return url.toString();
    } catch (error) {
      throw new Error(`Invalid endpoint URL: ${endpoint}. Must be a valid HTTP/HTTPS URL.`);
    }
  }

  // Check if gateway is still fresh (less than 1 hour old)
  public isFresh(): boolean {
    return Date.now() - this.timestamp < 3600000; // 1 hour
  }

  // Get age in human readable format
  public getAge(): string {
    const ageMs = Date.now() - this.timestamp;
    const minutes = Math.floor(ageMs / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    return `${minutes}m`;
  }

  // Update health status
  public updateHealth(isHealthy: boolean, chainId?: number): void {
    this.isHealthy = isHealthy;
    this.lastHealthCheck = Date.now();
    if (chainId !== undefined) {
      this.chainId = chainId;
    }
  }

  // Check if health check is recent (less than 5 minutes)
  public hasRecentHealthCheck(): boolean {
    return this.lastHealthCheck !== undefined && 
           Date.now() - this.lastHealthCheck < 300000; // 5 minutes
  }

  serialize(): string {
    return JSON.stringify({
      blockchainId: this.blockchainId,
      nodeId: this.nodeId,
      endpoint: this.endpoint,
      pubKey: this.pubKey,
      timestamp: this.timestamp,
      chainId: this.chainId,
      isHealthy: this.isHealthy,
      lastHealthCheck: this.lastHealthCheck
    });
  }

  static deserialize(data: string): GatewayInfo {
    try {
      const parsed: IGatewayInfo = JSON.parse(data);
      
      if (!parsed.blockchainId || !parsed.nodeId || !parsed.endpoint) {
        throw new Error('Missing required fields in gateway data');
      }

      const gateway = new GatewayInfo(
        parsed.blockchainId,
        parsed.nodeId,
        parsed.endpoint,
        parsed.pubKey
      );
      
      // Restore optional fields
      gateway.timestamp = parsed.timestamp || Date.now();
      gateway.chainId = parsed.chainId;
      gateway.isHealthy = parsed.isHealthy;
      gateway.lastHealthCheck = parsed.lastHealthCheck;
      
      return gateway;
    } catch (error) {
      throw new Error(`Failed to deserialize gateway data: ${error.message}`);
    }
  }

  // Create a summary object for API responses
  public toSummary(): object {
    return {
      blockchainId: this.blockchainId,
      nodeId: this.nodeId,
      endpoint: this.endpoint,
      pubKey: this.pubKey,
      timestamp: this.timestamp,
      age: this.getAge(),
      isFresh: this.isFresh(),
      chainId: this.chainId,
      isHealthy: this.isHealthy,
      hasRecentHealthCheck: this.hasRecentHealthCheck(),
      lastHealthCheck: this.lastHealthCheck
    };
  }
}