import { GatewayInfo, IGatewayInfo } from "../../gateway/gateway";
import { hashKeyAndmapToKeyspace } from "../../utils/nodeUtils";

export class GatewayManager {
  private registeredGateways: Map<string, GatewayInfo> = new Map();
  private gatewayHeartbeat?: NodeJS.Timeout;
  private nodeId: number;
  private storeCallback: (key: number, value: string) => Promise<any>;
  private findValueCallback: (value: string) => Promise<any>;
  private secureStoreCallback?: (key: number, value: string) => Promise<any>;
  private secureFindValueCallback?: (value: string) => Promise<any>;

  constructor(
    nodeId: number,
    storeCallback: (key: number, value: string) => Promise<any>,
    findValueCallback: (value: string) => Promise<any>,
    secureStoreCallback?: (key: number, value: string) => Promise<any>,
    secureFindValueCallback?: (value: string) => Promise<any>
  ) {
    this.nodeId = nodeId;
    this.storeCallback = storeCallback;
    this.findValueCallback = findValueCallback;
    this.secureStoreCallback = secureStoreCallback;
    this.secureFindValueCallback = secureFindValueCallback;
  }

  /**
   * Set secure callbacks (for late injection)
   */
  public setSecureCallbacks(
    secureStoreCallback: (key: number, value: string) => Promise<any>,
    secureFindValueCallback: (value: string) => Promise<any>
  ): void {
    this.secureStoreCallback = secureStoreCallback;
    this.secureFindValueCallback = secureFindValueCallback;
  }

  /**
   * Register this node as a gateway for a blockchain
   */
  public async registerAsGateway(
    blockchainId: string,
    endpoint: string,
    pubKey?: string
  ): Promise<GatewayInfo> {
    console.log(`Node ${this.nodeId} registering as gateway for ${blockchainId}${pubKey ? ` with pubKey: ${pubKey.substring(0, 20)}...` : ''}`);
    
    const gatewayInfo = new GatewayInfo(
      blockchainId,
      this.nodeId,
      endpoint,
      pubKey
    );

    this.registeredGateways.set(blockchainId, gatewayInfo);

    const gatewayKey = hashKeyAndmapToKeyspace(`gw-${blockchainId}`);
    const specificKey = hashKeyAndmapToKeyspace(`gw-${blockchainId}-${this.nodeId}`);
    
    console.log(`Storing with keys: Primary=${gatewayKey}, Specific=${specificKey}`);
    
    await Promise.allSettled([
      this.storeCallback(gatewayKey, gatewayInfo.serialize()),
      this.storeCallback(specificKey, gatewayInfo.serialize())
    ]);
    
    console.log(`Gateway registration completed for ${blockchainId}`);
    return gatewayInfo;
  }

  /**
   * Find gateways for a specific blockchain
   */
  public async findGateways(blockchainId: string): Promise<IGatewayInfo[]> {
    console.log(`\n=== GatewayManager: Finding gateways for ${blockchainId} ===`);
    
    const gateways: IGatewayInfo[] = [];
    const gatewayKey = hashKeyAndmapToKeyspace(`gw-${blockchainId}`);
    
    console.log(`Generated key: gw-${blockchainId} -> ${gatewayKey}`);
    
    // Check local registered gateways
    if (this.registeredGateways.has(blockchainId)) {
      const localGateway = this.registeredGateways.get(blockchainId)!;
      console.log(`Found in local registered gateways`);
      gateways.push(localGateway);
    }
    
    // Check DHT for stored gateways
    console.log(`\n--- Checking DHT storage ---`);
    try {
      const result = await this.findValueCallback(`gw-${blockchainId}`);
      
      if (result && result.value && typeof result.value === 'string') {
        try {
          const gateway = GatewayInfo.deserialize(result.value);
          console.log(`Successfully found DHT gateway: ${gateway.blockchainId} (node ${gateway.nodeId})`);
          
          if (gateway.blockchainId === blockchainId && 
              !gateways.find(g => g.nodeId === gateway.nodeId)) {
            gateways.push(gateway);
          }
        } catch (parseError) {
          console.error(`Failed to parse DHT gateway value:`, parseError.message);
        }
      }
    } catch (dhtError) {
      console.error(`Error accessing DHT:`, dhtError);
    }
    
    console.log(`\n=== Final result: ${gateways.length} gateway(s) for ${blockchainId} ===`);
    gateways.forEach((gw, i) => {
      console.log(`${i + 1}. ${gw.blockchainId} - node ${gw.nodeId} - ${gw.endpoint}`);
    });
    console.log(`==========================================\n`);
    
    return gateways;
  }

  /**
   * Find gateways securely
   */
  public async findGatewaysSecure(blockchainId: string): Promise<IGatewayInfo[]> {
    console.log(`\n=== GatewayManager: Finding gateways for ${blockchainId} (SECURE) ===`);
    
    const gateways: IGatewayInfo[] = [];
    const gatewayKey = hashKeyAndmapToKeyspace(`gw-${blockchainId}`);
    
    console.log(`Generated key: gw-${blockchainId} -> ${gatewayKey} (SECURE)`);
    
    // Check local registered gateways first
    if (this.registeredGateways.has(blockchainId)) {
      const localGateway = this.registeredGateways.get(blockchainId)!;
      console.log(`Found in local registered gateways`);
      gateways.push(localGateway);
    }
    
    // Check DHT for stored gateways using secure method if available
    console.log(`\n--- Checking DHT storage (SECURE) ---`);
    try {
      const findMethod = this.secureFindValueCallback || this.findValueCallback;
      const result = await findMethod(`gw-${blockchainId}`);
      
      if (result && result.value && typeof result.value === 'string') {
        try {
          const gateway = GatewayInfo.deserialize(result.value);
          console.log(`Successfully found secure DHT gateway: ${gateway.blockchainId} (node ${gateway.nodeId})`);
          
          if (gateway.blockchainId === blockchainId && 
              !gateways.find(g => g.nodeId === gateway.nodeId)) {
            gateways.push(gateway);
          }
        } catch (parseError) {
          console.error(`Failed to parse secure DHT gateway value:`, parseError.message);
        }
      } else {
        console.log(`No secure gateway data found in DHT for ${blockchainId}`);
      }
    } catch (dhtError) {
      console.error(`Error accessing secure DHT:`, dhtError);
      
      // Fallback to regular DHT if secure fails
      console.log(`Falling back to regular DHT lookup`);
      try {
        const result = await this.findValueCallback(`gw-${blockchainId}`);
        if (result && result.value && typeof result.value === 'string') {
          const gateway = GatewayInfo.deserialize(result.value);
          if (gateway.blockchainId === blockchainId && 
              !gateways.find(g => g.nodeId === gateway.nodeId)) {
            gateways.push(gateway);
            console.log(`Found gateway via fallback DHT: ${gateway.blockchainId} (node ${gateway.nodeId})`);
          }
        }
      } catch (fallbackError) {
        console.error(`Fallback DHT lookup also failed:`, fallbackError);
      }
    }
    
    // Try to find gateways stored with specific node keys
    console.log(`\n--- Checking for node-specific gateway entries (SECURE) ---`);
    try {
      // Look for gateways that might be stored with specific node IDs
      const nodeSpecificKey = `gw-${blockchainId}-`;
      
      // Since we can't easily iterate DHT, we'll check a few common node IDs
      const commonNodeIds = [0, 1, 2, 3, 4, 5]; // Bootstrap and first few nodes
      
      for (const nodeId of commonNodeIds) {
        try {
          const specificKey = `${nodeSpecificKey}${nodeId}`;
          const findMethod = this.secureFindValueCallback || this.findValueCallback;
          const result = await findMethod(specificKey);
          
          if (result && result.value && typeof result.value === 'string') {
            const gateway = GatewayInfo.deserialize(result.value);
            if (gateway.blockchainId === blockchainId && 
                !gateways.find(g => g.nodeId === gateway.nodeId)) {
              gateways.push(gateway);
              console.log(`Found node-specific secure gateway: ${gateway.blockchainId} (node ${gateway.nodeId})`);
            }
          }
        } catch (error) {
          // Silent fail for specific node checks
        }
      }
    } catch (nodeSpecificError) {
      console.log(`Node-specific secure search completed with some errors`);
    }
    
    console.log(`\n=== SECURE Final result: ${gateways.length} gateway(s) for ${blockchainId} ===`);
    gateways.forEach((gw, i) => {
      console.log(`${i + 1}. ${gw.blockchainId} - node ${gw.nodeId} - ${gw.endpoint} (${this.secureFindValueCallback ? 'ENCRYPTED' : 'FALLBACK'})`);
    });
    console.log(`================================================\n`);
    
    return gateways;
  }

  /**
   * Store gateway securely
   */
  public async storeGatewaySecure(gatewayInfo: GatewayInfo): Promise<any> {
    console.log(`GatewayManager: storing gateway securely for ${gatewayInfo.blockchainId}`);
    
    // Store locally
    this.registeredGateways.set(gatewayInfo.blockchainId, gatewayInfo);
    
    // Generate storage keys
    const gatewayKey = hashKeyAndmapToKeyspace(`gw-${gatewayInfo.blockchainId}`);
    const specificKey = hashKeyAndmapToKeyspace(`gw-${gatewayInfo.blockchainId}-${this.nodeId}`);
    
    console.log(`Storing securely with keys: Primary=${gatewayKey}, Specific=${specificKey}`);
    
    // Store using secure method if available, otherwise use regular store
    const storeMethod = this.secureStoreCallback || this.storeCallback;
    const isSecure = !!this.secureStoreCallback;
    
    console.log(`Using ${isSecure ? 'SECURE' : 'FALLBACK'} storage method`);
    
    const results = await Promise.allSettled([
      storeMethod(gatewayKey, gatewayInfo.serialize()),
      storeMethod(specificKey, gatewayInfo.serialize())
    ]);
    
    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    
    console.log(`Secure gateway storage completed: ${successful} successful, ${failed} failed (${isSecure ? 'ENCRYPTED' : 'FALLBACK'})`);
    
    // Log any failures
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const keyName = index === 0 ? 'Primary' : 'Specific';
        console.error(`${keyName} key storage failed:`, result.reason);
      }
    });
    
    return results;
  }

  /**
   * Start heartbeat for gateway registration
   */
  public startGatewayHeartbeat(
    blockchainId: string, 
    endpoint: string, 
    pubKey?: string, 
    interval: number = 300000
  ): void {
    this.gatewayHeartbeat = setInterval(async () => {
      console.log(`Refreshing gateway registration for ${blockchainId}`);
      await this.registerAsGateway(blockchainId, endpoint, pubKey);
    }, interval);
  }

  /**
   * Stop gateway heartbeat
   */
  public stopGatewayHeartbeat(): void {
    if (this.gatewayHeartbeat) {
      clearInterval(this.gatewayHeartbeat);
      this.gatewayHeartbeat = undefined;
    }
  }

  /**
   * Get all registered gateways
   */
  public getRegisteredGateways(): ReadonlyMap<string, GatewayInfo> {
    return this.registeredGateways;
  }

  /**
   * Cleanup method
   */
  public cleanup(): void {
    this.stopGatewayHeartbeat();
    this.registeredGateways.clear();
  }
}