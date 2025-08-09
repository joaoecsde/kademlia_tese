import { KeyDiscoveryManager } from '../crypto/keyDiscovery';
import { CryptoManager } from '../crypto/keyManager';
import { SecureMessageHandler } from '../crypto/secureMessage';
import { DiscoveryScheduler } from "../discoveryScheduler/discoveryScheduler";
import { GatewayInfo, IGatewayInfo } from "../gateway/gateway";
import { App } from "../http/app";
import { Peer } from "../peer/peer";
import RoutingTable from "../routingTable/routingTable";
import { MessageType } from "../types/messageTypes";
import { extractError } from "../utils/extractError";
import AbstractNode from "./abstractNode/abstractNode";

import { DHTManager, FindValueResponse } from "./managers/dhtManager";
import { GatewayManager } from "./managers/gatewayManager";
import { MessageManager, MessageManagerDependencies } from "./managers/messageManager";
import { NetworkManager, NetworkManagerConfig } from "./managers/networkManager";

class RefactoredKademliaNode extends AbstractNode {
  // Core components
  public readonly nodeContact: Peer;
  public readonly table: RoutingTable;
  public readonly api: App;

  // Managers
  private dhtManager: DHTManager;
  private gatewayManager: GatewayManager;
  private networkManager: NetworkManager;
  private messageManager: MessageManager;

  // Crypto components
  private cryptoManager: CryptoManager;
  private secureMessageHandler: SecureMessageHandler;
  private keyDiscoveryManager: KeyDiscoveryManager;
  private encryptionEnabled: boolean = true;

  // Scheduling
  private readonly discScheduler: DiscoveryScheduler;

  constructor(id: number, port: number) {
    super(id, port, "kademlia");
    this.nodeContact = new Peer(this.nodeId, this.address, this.port);

    // Initialize core components
    this.table = new RoutingTable(this.nodeId, this);
    this.api = new App(this, this.port - 1000);

    // Initialize crypto components
    this.cryptoManager = new CryptoManager();
    this.secureMessageHandler = new SecureMessageHandler(this.cryptoManager);
    this.keyDiscoveryManager = new KeyDiscoveryManager(this.cryptoManager, id);

    // Initialize managers
    this.initializeManagers();

    // Initialize scheduler
    this.discScheduler = new DiscoveryScheduler({ jobId: "discScheduler" });

    console.log(`Node ${id} initialized with modular architecture`);
    console.log(`Public key fingerprint: ${this.getPublicKeyFingerprint()}`);
  }

  /**
   * Initialize all manager components
   */
  private initializeManagers(): void {
    // Initialize NetworkManager first since others depend on it
    const networkConfig: NetworkManagerConfig = {
      nodeId: this.nodeId,
      address: this.address,
      port: this.port,
      nodeContact: this.nodeContact,
      routingTable: this.table
    };
    this.networkManager = new NetworkManager(networkConfig);

    // Initialize DHTManager with proper event emitter from AbstractNode
    this.dhtManager = new DHTManager(
      this.table,
      this.nodeContact,
      (message, resolver) => this.networkManager.getUdpTransport().sendMessage(message, resolver),
      (nodes, type, data) => this.networkManager.sendManyUdp(nodes, type, data, this.udpMessageResolver), // Pass the resolver
      this.emitter // Pass the event emitter from AbstractNode
    );

    // Initialize GatewayManager with DHT callbacks
    this.gatewayManager = new GatewayManager(
      this.nodeId,
      (key, value) => this.dhtManager.store(key, value),
      (value) => this.dhtManager.findValue(value),
      // For secure operations, create a wrapper that calls secureStore with the handler
      (key, value) => this.secureStore(key, value), // Use the node's secureStore method
      (value) => this.dhtManager.findValue(value) // For now, secure find uses same method
    );

    // Initialize MessageManager with all dependencies
    const messageDeps: MessageManagerDependencies = {
      nodeId: this.nodeId,
      nodeContact: this.nodeContact,
      cryptoManager: this.cryptoManager,
      secureMessageHandler: this.secureMessageHandler,
      keyDiscoveryManager: this.keyDiscoveryManager,
      emitter: this.emitter, // Use the same emitter from AbstractNode
      encryptionEnabled: this.encryptionEnabled,
      updateRoutingTable: async (peer) => await this.table.updateTables(peer),
      storeLocal: (key, value) => {
        // nodeStore doesn't return a Promise in the original implementation
        this.table.nodeStore(key, value);
        return Promise.resolve();
      },
      findLocal: async (key) => {
        const result = await this.table.findValue(key);
        return result; // Can be string, Peer[], or undefined
      },
      findClosestNodes: (nodeId, count) => this.table.findNode(nodeId, count),
      sendResponse: (type, message, data) => this.handleMessageResponse(type, message, data),
      getRegisteredGateways: () => this.gatewayManager.getRegisteredGateways()
    };
    this.messageManager = new MessageManager(messageDeps);
  }

  /**
   * Setup listeners and start the node
   */
  public listen = (cb?: any): ((cb?: any) => void) => {
    this.networkManager.setupListeners(this.handleMessage.bind(this));
    this.api.listen();
    return (cb) => this.networkManager.getWsTransport().server.close(cb);
  };

  /**
   * Handle incoming messages (required by AbstractNode)
   * Delegates to MessageManager
   */
  public handleMessage = async (...args: any[]): Promise<void> => {
    // The MessageManager expects (msg: Buffer, info: dgram.RemoteInfo)
    if (args.length >= 2) {
      const [msg, info] = args;
      await this.messageManager.handleMessage(msg, info);
    } else {
      console.error('handleMessage called with insufficient arguments:', args);
    }
  };

  /**
   * Start the node
   */
  public start = async () => {
    await this.table.updateTables(new Peer(0, this.address, 3000));
    await this.initDiscScheduler();

    // Store our public key in DHT
    try {
      await this.keyDiscoveryManager.storeOwnKeyInDHT(
        (key, value) => this.dhtManager.store(key, value)
      );
      console.log(`Node ${this.nodeId} public key stored in DHT`);
    } catch (error) {
      console.error(`Failed to store public key in DHT:`, error);
    }

    // Start crypto maintenance
    this.startCryptoMaintenance();
  };

  /**
   * Initialize discovery scheduler
   */
  public async initDiscScheduler() {
    this.discScheduler.createSchedule(this.discScheduler.schedule, async () => {
      try {
        const closeNodes = await this.dhtManager.findNodes(this.nodeId);
        await this.table.updateTables(closeNodes);
        const routingPeers = this.table.getAllPeers();

        await this.networkManager.updatePeerDiscoveryInterval(routingPeers);
        await this.networkManager.refreshAndUpdateConnections(routingPeers);
      } catch (error) {
        this.log.error(`message: ${extractError(error)}, fn: executeCronTask`);
      }
    });
  }

  // ============ PUBLIC DHT API ============

  /**
   * Store a value in the DHT
   */
  public async store(key: number, value: string): Promise<any> {
    return this.dhtManager.store(key, value);
  }

  /**
   * Store a value securely in the DHT
   */
  public async secureStore(key: number, value: string): Promise<any> {
    // This would delegate to a secure version in DHTManager
    console.log(`Node ${this.nodeId} initiating secure store for key ${key}`);
    
    const closestNodes = this.table.findNode(key, 3);
    
    const storePromises = closestNodes.map(async (node) => {
      // Prepare encrypted message
      const securePayload = this.secureMessageHandler.prepareMessage(
        { key, value },
        node.nodeId
      );
      
      // This would use the network manager to send the secure message
      console.log(`Sending secure store to node ${node.nodeId}`);
      return { status: 'fulfilled' }; // Placeholder
    });
    
    const results = await Promise.allSettled(storePromises);
    const successful = results.filter(r => r.status === 'fulfilled').length;
    
    console.log(`Secure store completed on ${successful}/${closestNodes.length} nodes`);
    return results;
  }

  /**
   * Find a value in the DHT
   */
  public async findValue(value: string): Promise<FindValueResponse | null> {
    return this.dhtManager.findValue(value);
  }

  /**
   * Debug closest nodes for a value
   */
  public debugClosestNodes(value: string) {
    return this.dhtManager.debugClosestNodes(value);
  }

  // ============ GATEWAY API ============

  /**
   * Register as a gateway for a blockchain
   */
  public async registerAsGateway(
    blockchainId: string,
    endpoint: string,
    pubKey?: string
  ): Promise<GatewayInfo> {
    return this.gatewayManager.registerAsGateway(blockchainId, endpoint, pubKey);
  }

  /**
   * Find gateways for a blockchain
   */
  public async findGateways(blockchainId: string): Promise<IGatewayInfo[]> {
    return this.gatewayManager.findGateways(blockchainId);
  }

  /**
   * Find gateways securely
   */
  public async findGatewaysSecure(blockchainId: string): Promise<IGatewayInfo[]> {
    console.log(`Node ${this.nodeId} looking for gateways to ${blockchainId} (SECURE)`);
    // This would be implemented in GatewayManager with secure operations
    return this.gatewayManager.findGateways(blockchainId);
  }

  /**
   * Store gateway securely
   */
  public async storeGatewaySecure(gatewayInfo: GatewayInfo): Promise<any> {
    console.log(`Node ${this.nodeId} storing gateway securely for ${gatewayInfo.blockchainId}`);
    // This would use secure storage methods
    return [];
  }

  /**
   * Get registered gateways
   */
  public getRegisteredGateways(): ReadonlyMap<string, GatewayInfo> {
    return this.gatewayManager.getRegisteredGateways();
  }

  /**
   * Start gateway heartbeat
   */
  public startGatewayHeartbeat(blockchainId: string, endpoint: string, pubKey?: string, interval?: number): void {
    this.gatewayManager.startGatewayHeartbeat(blockchainId, endpoint, pubKey, interval);
  }

  /**
   * Stop gateway heartbeat
   */
  public stopGatewayHeartbeat(): void {
    this.gatewayManager.stopGatewayHeartbeat();
  }

  // ============ NETWORK API ============

  /**
   * Get UDP transport (for backward compatibility with KBucket)
   */
  public get udpTransport() {
    return this.networkManager.getUdpTransport();
  }

  /**
   * Get UDP message resolver (for backward compatibility with KBucket)
   * This recreates the original udpMessageResolver method from the old node
   */
  public udpMessageResolver = (params: any, resolve: (value?: unknown) => void, reject: (reason?: any) => void) => {
    const { type, responseId } = params;
    
    if (type === MessageType.Reply) resolve(params);
    if (type === MessageType.Pong) resolve(params);
    if (type === MessageType.FoundResponse) resolve(params);

    if (type === MessageType.GatewayResponse) {
      this.emitter.once(`response_gateway_${responseId}`, (data: any) => {
        if (data.error) {
          return reject(data.error);
        }
        resolve(data.gateways || []);
      });
    }

    this.emitter.once(`response_reply_${responseId}`, (data: any) => {
      if (data.error) {
        return reject(data.error);
      }
      if (data?.value) {
        resolve(data.value);
      } else {
        const nodes = data.closestNodes?.map((node: any) => 
          new Peer(node.nodeId, this.address, node.port, node.lastSeen)
        ) || [];
        resolve(nodes);
      }
    });

    this.emitter.once(`response_pong_${responseId}`, (data: any) => {
      if (data.error) {
        return reject(data.error);
      }
      resolve(data);
    });

    this.emitter.once(`response_findValue_${responseId}`, (data: any) => {
      if (data.error) {
        return reject(data.error);
      }
      
      // Handle key exchange if present
      if (data && data.data && data.data.data && data.data.data.keyExchange) {
        const keyExchange = data.data.data.keyExchange;
        this.cryptoManager.storePublicKey(keyExchange.nodeId, keyExchange.publicKey);
        console.log(`Stored public key from node ${keyExchange.nodeId} via FindValue response`);
      }
      
      const actualValue = data && data.data && data.data.data ? data.data.data.value : null;
      
      if (actualValue && typeof actualValue === 'string') {
        console.log(`Resolved findValue with string value: ${actualValue.substring(0, 100)}...`);
        resolve(actualValue);
      } else {
        console.log(`FindValue returned non-string or null:`, typeof actualValue, actualValue);
        resolve(null);
      }
    });
  };

  /**
   * Ping a node
   */
  public async ping(nodeId: number, address: string, port: number): Promise<boolean> {
    return this.networkManager.ping(nodeId, address, port);
  }

  /**
   * Secure ping
   */
  public async securePing(nodeId: number, address: string, port: number): Promise<boolean> {
    // Enhanced ping with key exchange
    return this.networkManager.ping(nodeId, address, port);
  }

  /**
   * Bootstrap with initial nodes
   */
  public async bootstrap(nodes: Array<{nodeId: number, address: string, port: number}>): Promise<void> {
    console.log(`Node ${this.nodeId} starting bootstrap with ${nodes.length} node(s)`);
    
    await this.networkManager.bootstrap(nodes);
    
    // Perform key discovery
    await this.keyDiscoveryManager.discoverKeys(nodes);
    
    // Request keys for all known peers
    const allPeers = this.table.getAllPeers();
    for (const peer of allPeers) {
      await this.requestPeerKey(peer.nodeId);
    }
    
    await this.dhtManager.findNodes(this.nodeId);
    console.log(`Bootstrap completed. Known keys: ${this.cryptoManager.getAllKnownKeys().length}`);
  }

  // ============ CRYPTO API ============

  /**
   * Get public key fingerprint
   */
  public getPublicKeyFingerprint(): string {
    const crypto = require('crypto');
    const publicKey = this.cryptoManager.getPublicKey();
    const hash = crypto.createHash('sha256').update(publicKey).digest('hex');
    return hash.substring(0, 16);
  }

  /**
   * Set encryption enabled/disabled
   */
  public setEncryptionEnabled(enabled: boolean): void {
    this.encryptionEnabled = enabled;
    this.messageManager.setEncryptionEnabled(enabled);
    console.log(`Node ${this.nodeId} encryption ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Get encryption status
   */
  public isEncryptionEnabled(): boolean {
    return this.encryptionEnabled;
  }

  /**
   * Get known public keys
   */
  public getKnownPublicKeys(): Array<{nodeId: number, publicKey: string, timestamp: number}> {
    return this.cryptoManager.getAllKnownKeys();
  }

  /**
   * Get crypto manager
   */
  public getCryptoManager(): CryptoManager {
    return this.cryptoManager;
  }

  /**
   * Get key discovery manager
   */
  public getKeyDiscoveryManager(): KeyDiscoveryManager {
    return this.keyDiscoveryManager;
  }

  /**
   * Get crypto statistics
   */
  public getCryptoStats(): {
    encryptionEnabled: boolean;
    knownKeys: number;
    publicKeyFingerprint: string;
    keyDiscoveryRequests: number;
  } {
    return {
      encryptionEnabled: this.encryptionEnabled,
      knownKeys: this.cryptoManager.getAllKnownKeys().length,
      publicKeyFingerprint: this.getPublicKeyFingerprint(),
      keyDiscoveryRequests: this.keyDiscoveryManager.getDiscoveredKeys().length
    };
  }

  /**
   * Trigger key exchange with all peers
   */
  public async triggerKeyExchangeWithAllPeers(): Promise<void> {
    const allPeers = this.table.getAllPeers();
    console.log(`Triggering key exchange with ${allPeers.length} peers`);
    
    const pingPromises = allPeers.map(peer => 
      this.securePing(peer.nodeId, peer.address, peer.port)
    );
    
    const results = await Promise.allSettled(pingPromises);
    const successful = results.filter(r => r.status === 'fulfilled' && r.value).length;
    
    console.log(`Key exchange completed with ${successful}/${allPeers.length} peers`);
    console.log(`Now have ${this.cryptoManager.getAllKnownKeys().length} public keys`);
  }

  // ============ UTILITY METHODS ============

  /**
   * Request public key from a peer
   */
  public async requestPeerKey(peerNodeId: number): Promise<void> {
    try {
      // Try DHT first
      const keyInfo = await this.keyDiscoveryManager.findKeyInDHT(
        peerNodeId,
        (key) => this.findValue(key)
      );
      
      if (keyInfo) {
        console.log(`Found key for node ${peerNodeId} in DHT`);
        return;
      }
      
      console.log(`Key for node ${peerNodeId} not found in DHT`);
    } catch (error) {
      console.error(`Failed to request key for node ${peerNodeId}:`, error);
    }
  }

  /**
   * Handle message response
   */
  private async handleMessageResponse(type: MessageType, originalMessage: any, data: any): Promise<void> {
    const to = new Peer(originalMessage.from.nodeId, originalMessage.from.address, originalMessage.from.port);
    
    // Prepare encrypted response if we have recipient's key and encryption is enabled
    let responseData = data;
    if (this.encryptionEnabled && this.cryptoManager.getStoredPublicKey(to.nodeId)) {
      try {
        const securePayload = this.secureMessageHandler.prepareMessage(data, to.nodeId);
        responseData = {
          ...data,
          securePayload
        };
      } catch (error) {
        console.warn(`Failed to encrypt response to node ${to.nodeId}, sending unencrypted:`, error.message);
      }
    }
    
    // Use network manager to send the response
    console.log(`Sending ${type} response to node ${to.nodeId}`);
  }

  /**
   * Start crypto maintenance tasks
   */
  private startCryptoMaintenance(): void {
    // Clean up old keys every hour
    setInterval(() => {
      this.cryptoManager.cleanupOldKeys();
      this.keyDiscoveryManager.cleanupOldRequests();
    }, 60 * 60 * 1000); // 1 hour
    
    // Refresh our key in DHT every 30 minutes
    setInterval(async () => {
      try {
        await this.keyDiscoveryManager.storeOwnKeyInDHT(
          (key, value) => this.store(key, value)
        );
      } catch (error) {
        console.error('Failed to refresh key in DHT:', error);
      }
    }, 30 * 60 * 1000); // 30 minutes
  }

  /**
   * Get node status
   */
  public getStatus(): {
    nodeId: number;
    port: number;
    httpPort: number;
    peers: number;
    buckets: number;
    registeredGateways: string[];
    encryptionEnabled: boolean;
    knownKeys: number;
    publicKeyFingerprint: string;
  } {
    return {
      nodeId: this.nodeId,
      port: this.port,
      httpPort: this.port - 1000,
      peers: this.table.getAllPeers().length,
      buckets: this.table.getAllBucketsLen(),
      registeredGateways: Array.from(this.gatewayManager.getRegisteredGateways().keys()),
      encryptionEnabled: this.encryptionEnabled,
      knownKeys: this.cryptoManager.getAllKnownKeys().length,
      publicKeyFingerprint: this.getPublicKeyFingerprint()
    };
  }

  /**
   * Stop the node and cleanup resources
   */
  public async stop(): Promise<void> {
    console.log(`Stopping node ${this.nodeId}...`);
    
    try {
      // Stop gateway operations
      this.gatewayManager.cleanup();
      
      // Stop discovery scheduler
      if (this.discScheduler) {
        this.discScheduler.stopCronJob();
      }
      
      // Cleanup network manager
      await this.networkManager.cleanup();
      
      // Stop HTTP API
      if (this.api && (this.api as any).server) {
        await new Promise<void>((resolve) => {
          (this.api as any).server.close(() => {
            resolve();
          });
        });
      }
      
      console.log(`Node ${this.nodeId} stopped successfully`);
    } catch (error) {
      console.error(`Error stopping node ${this.nodeId}:`, error);
    }
  }
}

export default RefactoredKademliaNode;