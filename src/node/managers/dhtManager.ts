import { v4 } from "uuid";
import { Peer } from "../../peer/peer";
import RoutingTable from "../../routingTable/routingTable";
import { MessageType } from "../../types/messageTypes";
import { chunk, hashKeyAndmapToKeyspace, XOR } from "../../utils/nodeUtils";
import { ALPHA, BIT_SIZE } from "./../constants";
import { NodeUtils } from "./../nodeUtils";

export interface FindValueResponse {
  value: string | null;
  nodeInfo?: {
    nodeId: number;
    address: string;
    port: number;
  };
}

export class DHTManager {
  private routingTable: RoutingTable;
  private nodeContact: Peer;
  private sendMessageCallback: (message: any, resolver: any) => Promise<any>;
  private sendManyCallback: (nodes: Peer[], type: MessageType, data?: any, resolver?: any) => Promise<any>[];
  private eventEmitter: any; // P2PNetworkEventEmitter

  constructor(
    routingTable: RoutingTable,
    nodeContact: Peer,
    sendMessageCallback: (message: any, resolver: any) => Promise<any>,
    sendManyCallback: (nodes: Peer[], type: MessageType, data?: any, resolver?: any) => Promise<any>[],
    eventEmitter: any // P2PNetworkEventEmitter from AbstractNode
  ) {
    this.routingTable = routingTable;
    this.nodeContact = nodeContact;
    this.sendMessageCallback = sendMessageCallback;
    this.sendManyCallback = sendManyCallback;
    this.eventEmitter = eventEmitter;
  }

    /**
   * Store a value in the DHT
   */
  public async store(key: number, value: string): Promise<any> {
    console.log(`DHTManager: storing key ${key}, value: ${value?.substring(0, 100)}...`);
    
    if (typeof value !== 'string') {
      console.error(`Store method received non-string value:`, value);
      value = typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
    
    const closestNodes = this.routingTable.findNode(key, 3);
    
    console.log(`Storing on ${closestNodes.length} closest nodes to key ${key}:`, 
      closestNodes.map(n => ({ 
        nodeId: n.nodeId, 
        port: n.port, 
        distance: XOR(n.nodeId, key) 
      }))
    );
    
    // Store locally if we're one of the closest nodes
    if (closestNodes.length === 0 || !closestNodes.find(n => n.nodeId === this.nodeContact.nodeId)) {
      const selfDistance = XOR(this.nodeContact.nodeId, key);
      const shouldStoreLocally = closestNodes.length < 3 || 
        closestNodes.some(n => XOR(n.nodeId, key) > selfDistance);
      
      if (shouldStoreLocally) {
        console.log(`Also storing locally on node ${this.nodeContact.nodeId}`);
        await this.routingTable.nodeStore(key.toString(), value);
      }
    }
    
    const closestNodesChunked = chunk<Peer>(closestNodes, ALPHA);

    for (const nodes of closestNodesChunked) {
      try {
        const promises = this.sendManyCallback(nodes, MessageType.Store, {
          key,
          value,
        }); // Don't pass resolver here, it's handled by the callback
        const results = await Promise.all(promises);
        console.log(`Store operation completed on ${results.length} nodes`);
        return results;
      } catch (e) {
        console.error(e);
      }
    }
  }

  /**
   * Store a value securely in the DHT
   */
  public async secureStore(key: number, value: string, secureMessageHandler?: any): Promise<any> {
    console.log(`DHTManager: securely storing key ${key}`);
    
    const closestNodes = this.routingTable.findNode(key, 3);
    
    const storePromises = closestNodes.map(async (node) => {
      let payload: any = {
        resId: v4(),
        key,
        value
      };

      // Add secure payload if handler provided
      if (secureMessageHandler) {
        try {
          const securePayload = secureMessageHandler.prepareMessage(
            { key, value },
            node.nodeId
          );
          payload.securePayload = securePayload;
        } catch (error) {
          console.warn(`Failed to encrypt for node ${node.nodeId}:`, error.message);
        }
      }
      
      const to = new Peer(node.nodeId, this.nodeContact.address, node.port);
      const message = NodeUtils.createUdpMessage(
        MessageType.Store,
        payload,
        this.nodeContact,
        to
      );
      
      return this.sendMessageCallback(message, this.createMessageResolver());
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
    const key = hashKeyAndmapToKeyspace(value);
    console.log(`DHTManager: looking for value "${value}" with key ${key}`);
    
    // Check local storage first
    const localValue = await this.routingTable.findValue(key.toString());
    if (typeof localValue === 'string') {
      console.log(`Found value locally on node ${this.nodeContact.nodeId}`);
      return {
        value: localValue,
        nodeInfo: {
          nodeId: this.nodeContact.nodeId,
          address: this.nodeContact.address,
          port: this.nodeContact.port
        }
      };
    }
    
    const closestNodes = this.routingTable.findNode(key, 20);
    
    console.log(`Querying ${closestNodes.length} closest nodes for key ${key}:`, 
      closestNodes.slice(0, 5).map(n => ({ 
        nodeId: n.nodeId, 
        port: n.port,
        distance: XOR(n.nodeId, key)
      }))
    );
    
    const closestNodesChunked = chunk<Peer>(closestNodes, ALPHA);
    
    for (const nodes of closestNodesChunked) {
      try {
        const nodePromises = nodes.map(async (node) => {
          console.log(`Querying node ${node.nodeId} at port ${node.port}`);
          const result = await this.sendSingleFindValue(node, key);
          if (result) {
            console.log(`Found value "${result}" at node ${node.nodeId}`);
            return {
              value: result,
              nodeInfo: {
                nodeId: node.nodeId,
                address: node.address,
                port: node.port
              }
            };
          }
          return null;
        });
        
        const resolved = await Promise.all(nodePromises);
        
        for (const result of resolved) {
          if (result && result.value) {
            return result as FindValueResponse;
          }
        }
      } catch (e) {
        console.error(e);
      }
    }
    
    console.log(`Value not found in the network`);
    return null;
  }

  /**
   * Find nodes closest to a target
   */
  public async findNodes(key: number): Promise<Peer[]> {
    const contacts = new Map<string, Peer>();
    const shortlist = this.routingTable.findNode(key, ALPHA);

    const closeCandidate = shortlist[0];
    let iteration: number = null;
    await this.findNodeRecursiveSearch(contacts, shortlist, closeCandidate, iteration);
    return Array.from(contacts.values());
  }

  /**
   * Debug method to show closest nodes for a value
   */
  public debugClosestNodes(value: string) {
    const key = hashKeyAndmapToKeyspace(value);
    const allPeers = this.routingTable.getAllPeers();
    
    allPeers.push(this.nodeContact);
    
    const sorted = allPeers.sort((a, b) => {
      const distA = XOR(a.nodeId, key);
      const distB = XOR(b.nodeId, key);
      return distA - distB;
    });
    
    console.log(`\nNodes sorted by distance to key ${key} (for value "${value}"):`);
    sorted.slice(0, 10).forEach((peer, index) => {
      const distance = XOR(peer.nodeId, key);
      const isSelf = peer.nodeId === this.nodeContact.nodeId ? " (THIS NODE)" : "";
      console.log(`${index + 1}. Node ${peer.nodeId} (port ${peer.port}) - XOR distance: ${distance}${isSelf}`);
    });
    
    return sorted.slice(0, 5).map(peer => ({
      nodeId: peer.nodeId,
      port: peer.port,
      distance: XOR(peer.nodeId, key)
    }));
  }

  private sendManyStore(nodes: Peer[], data: any) {
    return nodes.map((node: Peer) => {
      const to = new Peer(node.nodeId, "127.0.0.1", node.port);
      const payload = { resId: v4(), ...data };
      const message = NodeUtils.createUdpMessage(MessageType.Store, payload, this.nodeContact, to);
      return this.sendMessageCallback(message, null); // Will need proper resolver
    });
  }

  private async sendSingleFindValue(node: Peer, key: number): Promise<string | null> {
    try {
      const to = new Peer(node.nodeId, "127.0.0.1", node.port);
      const payload = { resId: v4(), key };
      const message = NodeUtils.createUdpMessage(MessageType.FindValue, payload, this.nodeContact, to);
      
      console.log(`Sending FindValue request to node ${node.nodeId} for key ${key}`);
      
      const result = await this.sendMessageCallback(message, null); // Will need proper resolver
      
      if (typeof result === 'string') {
        return result;
      }
      
      if (result && typeof result === 'object' && (result as any).value) {
        const nestedValue = (result as any).value;
        return typeof nestedValue === 'string' ? nestedValue : null;
      }
      
      return null;
    } catch (error) {
      console.error(`Error querying node ${node.nodeId}:`, error.message);
      return null;
    }
  }

  private async findNodeRecursiveSearch(
    contacts: Map<string, Peer>, 
    nodeShortlist: Peer[], 
    candidate: Peer, 
    iteration: number
  ) {
    const findNodePromises: Array<Promise<boolean>> = [];

    iteration = iteration == null ? 0 : iteration + 1;
    const alphaContacts = nodeShortlist.slice(iteration * ALPHA, iteration * ALPHA + ALPHA);

    for (const node of alphaContacts) {
      if (contacts.has(node.nodeId.toString())) continue;
      findNodePromises.push(this.handleFindNodeQuery(contacts, node, nodeShortlist, candidate));
    }

    if (!findNodePromises.length) {
      console.log("No more contacts in shortlist");
      return;
    }

    const results = await Promise.all(findNodePromises);
    const isUpdatedClosest = results.some(Boolean);

    if (isUpdatedClosest && contacts.size < BIT_SIZE) {
      await this.findNodeRecursiveSearch(contacts, nodeShortlist, candidate, iteration);
    }
  }

  private async handleFindNodeQuery(
    contacts: Map<string, Peer>, 
    node: Peer, 
    nodeShortlist: Peer[], 
    candidate: Peer
  ): Promise<boolean> {
    let hasCloserThanExist = false;
    try {
      const to = node;
      const data = { resId: v4() };
      const message = NodeUtils.createUdpMessage(MessageType.FindNode, data, this.nodeContact, to);
      const closeNodes = await this.sendMessageCallback(message, this.createMessageResolver());

      let initialClosestNode = candidate;
      contacts.set(node.nodeId.toString(), node);

      if (Array.isArray(closeNodes)) {
        for (const currentCloseNode of closeNodes) {
          nodeShortlist.push(currentCloseNode);

          const currentDistance = this.routingTable.getBucketIndex(initialClosestNode.nodeId);
          const distance = this.routingTable.getBucketIndex(currentCloseNode.nodeId);

          if (distance < currentDistance) {
            initialClosestNode = currentCloseNode;
            hasCloserThanExist = true;
          }
        }
      }
    } catch (e) {
      console.log(`Error in handleFindNodeQuery: ${e.message}`);
    }
    return hasCloserThanExist;
  }

  private createMessageResolver() {
    return (params: any, resolve: (value?: unknown) => void, reject: (reason?: any) => void) => {
      const { type, responseId } = params;
      
      if (type === MessageType.Reply) {
        resolve(params);
      } else if (type === MessageType.Pong) {
        resolve(params);
      } else if (type === MessageType.FoundResponse) {
        resolve(params);
      } else {
        // For other message types, create event listeners if we have an emitter
        if (this.eventEmitter) {
          // Handle different response types
          this.eventEmitter.once(`response_reply_${responseId}`, (data: any) => {
            if (data.error) {
              return reject(data.error);
            }
            if (data?.value) {
              resolve(data.value);
            } else {
              const nodes = data.closestNodes?.map((node: any) => 
                new Peer(node.nodeId, node.address, node.port, node.lastSeen)
              ) || [];
              resolve(nodes);
            }
          });

          this.eventEmitter.once(`response_pong_${responseId}`, (data: any) => {
            if (data.error) {
              return reject(data.error);
            }
            resolve(data);
          });

          this.eventEmitter.once(`response_findValue_${responseId}`, (data: any) => {
            if (data.error) {
              return reject(data.error);
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

          // Timeout fallback
          setTimeout(() => {
            this.eventEmitter.removeAllListeners(`response_reply_${responseId}`);
            this.eventEmitter.removeAllListeners(`response_pong_${responseId}`);
            this.eventEmitter.removeAllListeners(`response_findValue_${responseId}`);
            reject(new Error(`Timeout waiting for response ${responseId}`));
          }, 10000);
        } else {
          // Fallback if no event emitter
          console.warn('No event emitter available for message resolution');
          setTimeout(() => resolve([]), 5000);
        }
      }
    };
  }
}