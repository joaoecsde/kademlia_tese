import * as dgram from "dgram";
import { pack } from "msgpackr";
import { v4 } from "uuid";
import { P2PNetworkEventEmitter } from "../../node/eventEmitter";
import { NodeUtils } from "../../node/nodeUtils";
import { Peer } from "../../peer/peer";
import RoutingTable from "../../routingTable/routingTable";
import WebSocketTransport from "../../transports/tcp/wsTransport";
import UDPTransport from "../../transports/udp/udpTransport";
import { MessageType, PacketType, Transports } from "../../types/messageTypes";
import { BroadcastData, DirectData } from "../../types/udpTransportTypes";

export interface NetworkManagerConfig {
  nodeId: number;
  address: string;
  port: number;
  nodeContact: Peer;
  routingTable: RoutingTable;
}

export class NetworkManager {
  private config: NetworkManagerConfig;
  private udpTransport: UDPTransport;
  private wsTransport: WebSocketTransport;
  private emitter: P2PNetworkEventEmitter;
  private contacted = new Map<string, number>();

  constructor(config: NetworkManagerConfig) {
    this.config = config;
    this.udpTransport = new UDPTransport(config.nodeId, config.port);
    this.wsTransport = new WebSocketTransport(config.nodeId, config.port);
    this.emitter = new P2PNetworkEventEmitter(false);
  }

  /**
   * Initialize network listeners
   */
  public setupListeners(messageHandler: (msg: Buffer, info: dgram.RemoteInfo) => Promise<void>): void {
    this.udpTransport.onMessage(messageHandler);
    this.wsTransport.onMessage(this.handleBroadcastMessage, PacketType.Broadcast);
    this.wsTransport.onMessage(this.handleDirectMessage, PacketType.Direct);
    this.wsTransport.onPeerDisconnect(this.handleTcpDisconnect);
    this.wsTransport.onPeerConnection(() => null);
  }

  /**
   * Send ping to a node
   */
  public async ping(nodeId: number, address: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const to = new Peer(nodeId, address, port);
      const payload = { resId: v4() };
      const message = NodeUtils.createUdpMessage(MessageType.Ping, payload, this.config.nodeContact, to);
      
      const timeoutId = setTimeout(() => {
        this.emitter.removeAllListeners(`response_pong_${payload.resId}`);
        resolve(false);
      }, 2000);
      
      this.emitter.once(`response_pong_${payload.resId}`, () => {
        clearTimeout(timeoutId);
        resolve(true);
      });
      
      this.udpTransport.server.send(
        pack(message),
        port,
        address,
        (err) => {
          if (err) {
            clearTimeout(timeoutId);
            this.emitter.removeAllListeners(`response_pong_${payload.resId}`);
            resolve(false);
          }
        }
      );
    });
  }

  /**
   * Send message to multiple nodes via UDP
   */
  public sendManyUdp(nodes: Peer[], type: MessageType, data?: any, messageResolver?: any) {
    return nodes.map((node: Peer) => {
      const to = new Peer(node.nodeId, this.config.address, node.port);
      const payload = { resId: v4(), ...data };
      const message = NodeUtils.createUdpMessage(type, payload, this.config.nodeContact, to);
      return this.udpTransport.sendMessage(message, messageResolver);
    });
  }

  /**
   * Send TCP transport message
   */
  public sendTcpTransportMessage<T extends BroadcastData | DirectData>(type: MessageType, payload: T) {
    const message = NodeUtils.creatTcpMessage<T>(type, payload, this.config.nodeContact, this.config.nodeContact);
    this.wsTransport.sendMessage<T>(message);
  }

  /**
   * Get transport messages
   */
  public getTransportMessages(transport: Transports, type: MessageType) {
    switch (transport) {
      case Transports.Tcp:
        return this.wsTransport.messages[type];
      case Transports.Udp:
        return this.udpTransport.messages[type];
      default:
        console.error("No messages for this transport or type");
    }
  }

  /**
   * Bootstrap connection to initial nodes
   */
  public async bootstrap(nodes: Array<{nodeId: number, address: string, port: number}>): Promise<void> {
    console.log(`NetworkManager: starting bootstrap with ${nodes.length} node(s)`);
    
    for (const node of nodes) {
      try {
        const peer = new Peer(node.nodeId, node.address, node.port);
        await this.config.routingTable.updateTables(peer);
        
        // Ping the node to establish connection
        const pingResult = await this.ping(node.nodeId, node.address, node.port);
        
        if (pingResult) {
          console.log(`Successfully connected to bootstrap node ${node.nodeId}`);
        } else {
          console.warn(`Failed to ping bootstrap node ${node.nodeId}`);
        }
      } catch (error) {
        console.error(`Failed to connect to bootstrap node ${node.nodeId}:`, error);
      }
    }
    
    console.log('Bootstrap completed');
  }

  /**
   * Update peer discovery interval based on network state
   */
  public async updatePeerDiscoveryInterval(peers: Peer[]): Promise<boolean> {
    // Logic to determine if network is established and update intervals
    // Returns whether schedule should be updated
    return false; // Placeholder
  }

  /**
   * Refresh and update connections
   */
  public async refreshAndUpdateConnections(closestPeers: Peer[]): Promise<void> {
    const ws = this.wsTransport;
    for (const peer of closestPeers) {
      const peerId = peer.nodeId.toString();

      if (!ws.connections.has(peerId)) {
        this.wsTransport.connect(peer.port, () => {
          console.log(`Connection from ${this.config.nodeId} to ${peer.port} established.`);
        });
      }
    }
  }

  /**
   * Handle broadcast messages
   */
  private handleBroadcastMessage = async () => {
    console.log(`Receiving broadcasting message: ${this.config.port}`);
  };

  /**
   * Handle direct messages
   */
  private handleDirectMessage = async () => {
    console.log(`Receiving direct message: ${this.config.port}`);
  };

  /**
   * Handle TCP disconnection
   */
  private handleTcpDisconnect = async (nodeId: number) => {
    this.wsTransport.connections.delete(nodeId.toString());
    this.wsTransport.neighbors.delete(nodeId.toString());

    if (this.config.nodeId === nodeId) return;
    
    const peer = new Peer(nodeId, this.config.address, nodeId + 3000);
    const bucket = this.config.routingTable.findBucket(peer);
    bucket.removeNode(peer);
  };

  /**
   * Get network status
   */
  public getNetworkStatus() {
    return {
      nodeId: this.config.nodeId,
      port: this.config.port,
      peers: this.config.routingTable.getAllPeers().length,
      buckets: this.config.routingTable.getAllBucketsLen(),
      connections: {
        udp: !!this.udpTransport.server,
        tcp: this.wsTransport.connections.size,
        neighbors: this.wsTransport.neighbors.size
      }
    };
  }

  /**
   * Get UDP transport
   */
  public getUdpTransport(): UDPTransport {
    return this.udpTransport;
  }

  /**
   * Get WebSocket transport
   */
  public getWsTransport(): WebSocketTransport {
    return this.wsTransport;
  }

  /**
   * Get event emitter
   */
  public getEmitter(): P2PNetworkEventEmitter {
    return this.emitter;
  }

  /**
   * Cleanup network resources
   */
  public async cleanup(): Promise<void> {
    console.log(`Cleaning up network manager for node ${this.config.nodeId}`);
    
    try {
      if (this.udpTransport && this.udpTransport.server) {
        await new Promise<void>((resolve) => {
          this.udpTransport.server.close(() => resolve());
        });
      }
      
      if (this.wsTransport) {
        this.wsTransport.connections.clear();
        this.wsTransport.neighbors.clear();
        
        if (this.wsTransport.server) {
          await new Promise<void>((resolve) => {
            this.wsTransport.server.close(() => resolve());
          });
        }
      }
      
      if (this.emitter) {
        this.emitter.removeAllListeners();
      }
      
      console.log(`Network manager cleanup completed for node ${this.config.nodeId}`);
    } catch (error) {
      console.error(`Error during network cleanup for node ${this.config.nodeId}:`, error);
    }
  }
}