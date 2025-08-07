import { v4 } from 'uuid';
import { hashKeyAndmapToKeyspace } from '../utils/nodeUtils';
import { CryptoManager, NodeKeyInfo } from './keyManager';

export interface KeyDiscoveryRequest {
  requestId: string;
  requestorNodeId: number;
  targetNodeId?: number; // If looking for specific node
  timestamp: number;
}

export interface KeyDiscoveryResponse {
  requestId: string;
  nodeKeys: NodeKeyInfo[];
  responderNodeId: number;
  timestamp: number;
}

export class KeyDiscoveryManager {
  private pendingRequests: Map<string, KeyDiscoveryRequest> = new Map();
  private discoveredKeys: Map<number, NodeKeyInfo> = new Map();

  constructor(
    private cryptoManager: CryptoManager,
    private nodeId: number
  ) {}

  /**
   * Initiate key discovery during bootstrap
   */
  public async discoverKeys(knownNodes: Array<{nodeId: number, address: string, port: number}>): Promise<void> {
    console.log(`Node ${this.nodeId} starting key discovery with ${knownNodes.length} known nodes`);
    
    const promises = knownNodes.map(node => this.requestNodeKey(node.nodeId));
    const results = await Promise.allSettled(promises);
    
    const successful = results.filter(r => r.status === 'fulfilled').length;
    console.log(`Key discovery completed: ${successful}/${knownNodes.length} successful`);
  }

  /**
   * Request public key from a specific node
   */
  public async requestNodeKey(targetNodeId: number): Promise<NodeKeyInfo | null> {
    const requestId = v4();
    const request: KeyDiscoveryRequest = {
      requestId,
      requestorNodeId: this.nodeId,
      targetNodeId,
      timestamp: Date.now()
    };

    this.pendingRequests.set(requestId, request);

    try {
      return null;
    } catch (error) {
      console.error(`Key discovery failed for node ${targetNodeId}:`, error);
      this.pendingRequests.delete(requestId);
      return null;
    }
  }

  /**
   * Handle incoming key discovery request
   */
  public handleKeyDiscoveryRequest(request: KeyDiscoveryRequest): KeyDiscoveryResponse {
    console.log(`Node ${this.nodeId} received key discovery request from node ${request.requestorNodeId}`);
    
    const allKnownKeys = this.cryptoManager.getAllKnownKeys();
    
    const ourKey: NodeKeyInfo = {
      nodeId: this.nodeId,
      publicKey: this.cryptoManager.getPublicKey(),
      timestamp: Date.now()
    };

    const response: KeyDiscoveryResponse = {
      requestId: request.requestId,
      nodeKeys: [ourKey, ...allKnownKeys],
      responderNodeId: this.nodeId,
      timestamp: Date.now()
    };

    return response;
  }

  /**
   * Handle key discovery response
   */
  public handleKeyDiscoveryResponse(response: KeyDiscoveryResponse): void {
    console.log(`Node ${this.nodeId} received key discovery response from node ${response.responderNodeId} with ${response.nodeKeys.length} keys`);
    
    const request = this.pendingRequests.get(response.requestId);
    if (!request) {
      console.warn('Received response for unknown key discovery request');
      return;
    }

    for (const keyInfo of response.nodeKeys) {
      if (keyInfo.nodeId !== this.nodeId) { // Don't store our own key
        this.cryptoManager.storePublicKey(keyInfo.nodeId, keyInfo.publicKey);
        this.discoveredKeys.set(keyInfo.nodeId, keyInfo);
      }
    }

    this.pendingRequests.delete(response.requestId);
  }

  /**
   * Get discovered keys
   */
  public getDiscoveredKeys(): NodeKeyInfo[] {
    return Array.from(this.discoveredKeys.values());
  }

  /**
   * Clean up old requests
   */
  public cleanupOldRequests(): void {
    const maxAge = 30000; // 30 seconds
    const now = Date.now();
    
    for (const [requestId, request] of this.pendingRequests.entries()) {
      if (now - request.timestamp > maxAge) {
        this.pendingRequests.delete(requestId);
      }
    }
  }

  /**
   * Store keys in DHT for network-wide discovery
   */
  public async storeOwnKeyInDHT(storeFunction: (key: number, value: string) => Promise<any>): Promise<void> {
    const keyData: NodeKeyInfo = {
      nodeId: this.nodeId,
      publicKey: this.cryptoManager.getPublicKey(),
      timestamp: Date.now()
    };

    const storageKey = hashKeyAndmapToKeyspace(`pubkey-${this.nodeId}`);
    await storeFunction(storageKey, JSON.stringify(keyData));
    
    console.log(`Node ${this.nodeId} stored public key in DHT with key ${storageKey}`);
  }

  /**
   * Find public key in DHT
   */
  public async findKeyInDHT(
    targetNodeId: number, 
    findFunction: (key: string) => Promise<any>
  ): Promise<NodeKeyInfo | null> {
    const storageKey = hashKeyAndmapToKeyspace(`pubkey-${targetNodeId}`);
    
    try {
      const result = await findFunction(storageKey.toString());
      if (result && result.value) {
        const keyInfo: NodeKeyInfo = JSON.parse(result.value);
        
        // Verify the key belongs to the right node
        if (keyInfo.nodeId === targetNodeId) {
          this.cryptoManager.storePublicKey(keyInfo.nodeId, keyInfo.publicKey);
          this.discoveredKeys.set(keyInfo.nodeId, keyInfo);
          return keyInfo;
        }
      }
    } catch (error) {
      console.error(`Failed to find key for node ${targetNodeId} in DHT:`, error);
    }
    
    return null;
  }
}
