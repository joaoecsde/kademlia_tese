import * as dgram from "dgram";
import { unpack } from "msgpackr";
import { KeyDiscoveryManager } from '../../crypto/keyDiscovery';
import { CryptoManager } from '../../crypto/keyManager';
import { SecureMessageHandler } from '../../crypto/secureMessage';
import { IGatewayInfo } from "../../gateway/gateway";
import { Message, MessagePayload, UDPDataInfo } from "../../message/message";
import { P2PNetworkEventEmitter } from "../../node/eventEmitter";
import { Peer } from "../../peer/peer";
import { MessageType } from "../../types/messageTypes";
import { extractError } from "../../utils/extractError";
import { hashKeyAndmapToKeyspace } from "../../utils/nodeUtils";

type StoreData = MessagePayload<UDPDataInfo & { 
  key?: string; 
  value?: string;
  blockchainId?: string;
  gateways?: IGatewayInfo[];
  securePayload?: any;
  keyExchange?: {
    nodeId: number;
    publicKey: string;
    timestamp: number;
    requestType: 'offer' | 'request' | 'response';
  };
}>;

export interface MessageManagerDependencies {
  nodeId: number;
  nodeContact: Peer;
  cryptoManager: CryptoManager;
  secureMessageHandler: SecureMessageHandler;
  keyDiscoveryManager: KeyDiscoveryManager;
  emitter: P2PNetworkEventEmitter;
  encryptionEnabled: boolean;
  // Callbacks for operations
  updateRoutingTable: (peer: Peer) => Promise<void>;
  storeLocal: (key: string, value: string) => Promise<void> | void;
  findLocal: (key: string) => Promise<string | Peer[] | undefined>;
  findClosestNodes: (nodeId: number, count: number) => Peer[];
  sendResponse: (type: MessageType, message: any, data: any) => Promise<void>;
  getRegisteredGateways: () => ReadonlyMap<string, any>;
}

export class MessageManager {
  private deps: MessageManagerDependencies;

  constructor(dependencies: MessageManagerDependencies) {
    this.deps = dependencies;
  }

  /**
   * Main message handler
   */
  public async handleMessage(msg: Buffer, info: dgram.RemoteInfo): Promise<void> {
    try {
      const rawMessage = unpack(msg) as Message<StoreData>;
      const senderNodeId = rawMessage.from.nodeId;

      // Handle key discovery messages first (always unencrypted)
      if (rawMessage.type === 'KEY_DISCOVERY' || rawMessage.type === 'KEY_RESPONSE') {
        await this.handleKeyDiscoveryMessage(rawMessage);
        return;
      }

      // Process secure payload if present
      let processedMessage = rawMessage;
      if (rawMessage.data?.data?.securePayload) {
        try {
          const decryptedData = this.deps.secureMessageHandler.processMessage(
            rawMessage.data.data.securePayload,
            senderNodeId
          );
          
          // Replace the secure payload with decrypted data
          processedMessage.data.data = {
            ...rawMessage.data.data,
            ...decryptedData
          };
          
          console.log(`Successfully decrypted message from node ${senderNodeId}`);
        } catch (decryptError) {
          console.error(`Failed to decrypt message from node ${senderNodeId}:`, decryptError);
          return;
        }
      }

      // Update routing table with sender info
      await this.deps.updateRoutingTable(
        new Peer(processedMessage.from.nodeId, processedMessage.from.address, processedMessage.from.port)
      );

      // Route message based on type
      switch (processedMessage.type) {
        case MessageType.Store:
          await this.handleStoreMessage(processedMessage);
          break;
        case MessageType.Ping:
          await this.handlePingMessage(processedMessage);
          break;
        case MessageType.Reply:
          await this.handleReplyMessage(processedMessage);
          break;
        case MessageType.Pong:
          await this.handlePongMessage(processedMessage);
          break;
        case MessageType.FoundResponse:
          await this.handleFoundResponseMessage(processedMessage);
          break;
        case MessageType.FindNode:
          await this.handleFindNodeMessage(processedMessage);
          break;
        case MessageType.FindValue:
          await this.handleFindValueMessage(processedMessage);
          break;
        case MessageType.FindGateway:
          await this.handleFindGatewayMessage(processedMessage);
          break;
        default:
          console.warn(`Unknown message type: ${processedMessage.type}`);
      }
    } catch (e) {
      const errorMessage = extractError(e);
      console.error(`MessageManager error: ${errorMessage}`);
    }
  }

  /**
   * Handle STORE messages
   */
  private async handleStoreMessage(message: Message<StoreData>): Promise<void> {
    const key = message.data.data?.key;
    const value = message.data.data?.value;
    
    console.log(`MessageManager: received STORE message:`, {
      key,
      valueType: typeof value,
      valueLength: value?.length,
      encrypted: !!message.data.data?.securePayload,
      valuePreview: value?.substring(0, 50) + (value?.length > 50 ? '...' : '')
    });
    
    if (typeof value === 'string') {
      await this.deps.storeLocal(key, value);
    } else {
      console.error(`Received non-string value in STORE message:`, value);
      const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
      await this.deps.storeLocal(key, stringValue);
    }
    
    await this.deps.sendResponse(MessageType.Pong, message, message.data?.data);
  }

  /**
   * Handle PING messages
   */
  private async handlePingMessage(message: Message<StoreData>): Promise<void> {
    // Handle key exchange in ping
    if (message.data.data.keyExchange) {
      this.deps.cryptoManager.storePublicKey(
        message.data.data.keyExchange.nodeId,
        message.data.data.keyExchange.publicKey
      );
      console.log(`Stored public key from node ${message.data.data.keyExchange.nodeId} via ping`);
    }
    
    // Send pong with our public key
    const responseData = {
      resId: message.data.data.resId,
      keyExchange: {
        nodeId: this.deps.nodeId,
        publicKey: this.deps.cryptoManager.getPublicKey(),
        timestamp: Date.now(),
        requestType: 'response' as const
      }
    };
    
    await this.deps.sendResponse(MessageType.Pong, message, responseData);
  }

  /**
   * Handle REPLY messages
   */
  private async handleReplyMessage(message: Message<StoreData>): Promise<void> {
    const resId = message.data.data.resId;
    this.deps.emitter.emit(`response_reply_${resId}`, { ...message.data?.data, error: null });
  }

  /**
   * Handle PONG messages
   */
  private async handlePongMessage(message: Message<StoreData>): Promise<void> {
    const resId = message.data.data.resId;
    
    // Handle key exchange in pong
    if (message.data.data.keyExchange) {
      this.deps.cryptoManager.storePublicKey(
        message.data.data.keyExchange.nodeId,
        message.data.data.keyExchange.publicKey
      );
      console.log(`Stored public key from node ${message.data.data.keyExchange.nodeId} via pong`);
    }
    
    this.deps.emitter.emit(`response_pong_${resId}`, { resId, error: null });
  }

  /**
   * Handle FOUND_RESPONSE messages
   */
  private async handleFoundResponseMessage(message: Message<StoreData>): Promise<void> {
    const m = (message as any).data.data;
    this.deps.emitter.emit(`response_findValue_${m.resId}`, { ...message, error: null });
  }

  /**
   * Handle FIND_NODE messages
   */
  private async handleFindNodeMessage(message: Message<StoreData>): Promise<void> {
    const externalContact = message.from.nodeId;
    const closestNodes = this.deps.findClosestNodes(externalContact, 3); // ALPHA
    const msgData = { resId: message.data.data.resId, closestNodes };

    await this.deps.sendResponse(MessageType.Reply, message, msgData);
  }

  /**
   * Handle FIND_VALUE messages
   */
  private async handleFindValueMessage(message: Message<StoreData>): Promise<void> {
    const externalContact = message.from.nodeId;
    
    // Handle key exchange first
    if (message.data.data.keyExchange) {
      const keyExchange = message.data.data.keyExchange;
      this.deps.cryptoManager.storePublicKey(keyExchange.nodeId, keyExchange.publicKey);
      console.log(`Stored public key from node ${keyExchange.nodeId} via FindValue request`);
    }

    // Check if this is an encrypted request
    let searchKey = message.data.data.key;
    
    if (message.data.data?.securePayload) {
      console.log(`Received encrypted FindValue request from node ${externalContact}`);
    } else {
      console.log(`Received unencrypted FindValue request from node ${externalContact}`);
    }

    const res = await this.deps.findLocal(searchKey);
    
    // Handle the result properly - could be string, Peer[], or undefined
    let value: string | null = null;
    if (typeof res === 'string') {
      value = res;
    } else if (Array.isArray(res)) {
      // If we got Peer[], it means the value wasn't found locally
      value = null;
    } else {
      // undefined means not found
      value = null;
    }
    
    if (value && typeof value === 'string') {
      const displayValue = value.substring(0, 100);
      console.log(`Found value for key ${searchKey}: ${displayValue}${value.length > 100 ? '...' : ''}`);
    } else {
      console.log(`Did not find value for key ${searchKey}`);
    }
    
    // Create base response data
    let responseData: any = { 
      resId: message.data.data.resId, 
      value 
    };

    // Always add our key exchange in response
    responseData.keyExchange = {
      nodeId: this.deps.nodeId,
      publicKey: this.deps.cryptoManager.getPublicKey(),
      timestamp: Date.now(),
      requestType: 'response' as const
    };

    // If we have the sender's key, encrypt the response
    const hasSenderKey = !!this.deps.cryptoManager.getStoredPublicKey(externalContact);
    if (this.deps.encryptionEnabled && hasSenderKey) {
      try {
        const secureResponsePayload = this.deps.secureMessageHandler.prepareMessage(
          { resId: responseData.resId, value, keyExchange: responseData.keyExchange },
          externalContact
        );
        responseData.securePayload = secureResponsePayload;
        console.log(`Encrypting FindValue response to node ${externalContact}`);
      } catch (error) {
        console.warn(`Failed to encrypt FindValue response to node ${externalContact}:`, error.message);
      }
    } else {
      console.log(`Sending unencrypted FindValue response to node ${externalContact} (encryption: ${this.deps.encryptionEnabled}, hasKey: ${hasSenderKey})`);
    }
    
    await this.deps.sendResponse(MessageType.FoundResponse, message, responseData);
  }

  /**
   * Handle FIND_GATEWAY messages
   */
  private async handleFindGatewayMessage(message: Message<StoreData>): Promise<void> {
    const blockchainId = message.data.data?.blockchainId;
    if (!blockchainId) {
      console.error('FindGateway message missing blockchainId');
      return;
    }
    
    console.log(`Received FindGateway request for ${blockchainId}`);
    
    const localGateways: IGatewayInfo[] = [];
    const registeredGateways = this.deps.getRegisteredGateways();
    
    if (registeredGateways.has(blockchainId)) {
      const gateway = registeredGateways.get(blockchainId)!;
      if (Date.now() - gateway.timestamp < 3600000) {
        localGateways.push(gateway);
        console.log(`Found local registered gateway for ${blockchainId}`);
      }
    }
    
    const gatewayKey = hashKeyAndmapToKeyspace(`gw-${blockchainId}`);
    console.log(`Checking local storage for key: ${gatewayKey}`);
    
    const storedValue = await this.deps.findLocal(gatewayKey.toString());
    if (typeof storedValue === 'string') {
      console.log(`Found stored value for ${blockchainId}:`, storedValue.substring(0, 100));
      try {
        const parsedGateways = this.parseGatewayData(storedValue);
        for (const gateway of parsedGateways) {
          if (gateway.blockchainId === blockchainId &&
              Date.now() - gateway.timestamp < 3600000 &&
              !localGateways.find(g => g.nodeId === gateway.nodeId)) {
            localGateways.push(gateway);
            console.log(`Added stored gateway for ${blockchainId}: node ${gateway.nodeId}`);
          }
        }
      } catch (e) {
        console.error('Error parsing stored gateway data:', e);
      }
    } else {
      console.log(`No stored value found for key ${gatewayKey}`);
    }
    
    console.log(`Responding with ${localGateways.length} gateways for ${blockchainId}`);
    
    const msgData = { 
      resId: message.data.data.resId, 
      gateways: localGateways
    };
    
    await this.deps.sendResponse(MessageType.GatewayResponse, message, msgData);
  }

  /**
   * Handle key discovery messages
   */
  private async handleKeyDiscoveryMessage(message: any): Promise<void> {
    const keyExchange = message.data.data.keyExchange;
    const senderNodeId = message.from.nodeId;
    
    if (keyExchange.requestType === 'request') {
      // Store sender's public key
      this.deps.cryptoManager.storePublicKey(senderNodeId, keyExchange.publicKey);
      console.log(`Received key discovery request from node ${senderNodeId}`);
      
      // Send our key back
      const responsePayload = {
        resId: message.data.data.resId,
        keyExchange: {
          nodeId: this.deps.nodeId,
          publicKey: this.deps.cryptoManager.getPublicKey(),
          timestamp: Date.now(),
          requestType: 'response'
        }
      };
      
      // Note: This would need the actual UDP transport to send
      console.log(`Would send key response to node ${senderNodeId}`);
      
    } else if (keyExchange.requestType === 'response') {
      // Store received public key
      this.deps.cryptoManager.storePublicKey(senderNodeId, keyExchange.publicKey);
      console.log(`Received public key from node ${senderNodeId} via key discovery`);
    }
  }

  /**
   * Parse gateway data from different formats
   */
  private parseGatewayData(data: string): IGatewayInfo[] {
    const gateways: IGatewayInfo[] = [];
    
    if (!data || typeof data !== 'string') {
      return gateways;
    }
    
    try {
      // Try parsing as single gateway
      const parsed = JSON.parse(data);
      if (parsed.blockchainId && parsed.nodeId && parsed.endpoint) {
        gateways.push(parsed);
        return gateways;
      }
    } catch (error) {
      // Try parsing as concatenated JSON
      try {
        const parts = data.split('}{');
        for (let i = 0; i < parts.length; i++) {
          let jsonStr = parts[i];
          
          if (i === 0) {
            jsonStr = jsonStr + '}';
          } else if (i === parts.length - 1) {
            jsonStr = '{' + jsonStr;
          } else {
            jsonStr = '{' + jsonStr + '}';
          }
          
          try {
            const gateway = JSON.parse(jsonStr);
            if (gateway.blockchainId && gateway.nodeId && gateway.endpoint) {
              gateways.push(gateway);
            }
          } catch (parseError) {
            console.warn(`Failed to parse gateway part ${i}:`, parseError.message);
          }
        }
      } catch (splitError) {
        console.error('Error parsing concatenated gateway data:', splitError);
      }
    }
    
    return gateways;
  }

  /**
   * Set encryption enabled state
   */
  public setEncryptionEnabled(enabled: boolean): void {
    this.deps.encryptionEnabled = enabled;
  }

  /**
   * Get encryption status
   */
  public isEncryptionEnabled(): boolean {
    return this.deps.encryptionEnabled;
  }
}