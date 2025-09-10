import { v4 } from "uuid";
import { GatewayInfo, IGatewayInfo } from "../gateway/gateway";
import { Peer } from "../peer/peer";
import { MessageType } from "../types/messageTypes";
import { chunk, hashKeyAndmapToKeyspace, XOR } from "../utils/nodeUtils";
import { ALPHA } from "./constants";
import { NodeUtils } from "./nodeUtils";

interface FindValueResponse {
    value: string | null;
    nodeInfo?: {
      nodeId: number;
      address: string;
      port: number;
    };
}

export class DHTOperations {
    constructor(private node: any) {}

    /**
     * Store operation - distributes data across the DHT
     */
    public async store(key: number, value: string): Promise<any> {
		console.log(`Node ${this.node.nodeId} initiating store for key ${key}, value type: ${typeof value}, value: ${value?.substring(0, 100)}...`);
		
		if (typeof value !== 'string') {
			console.error(`Store method received non-string value:`, value);
			value = typeof value === 'object' ? JSON.stringify(value) : String(value);
		}
		
		const closestNodes = this.node.table.findNode(key, 3);
		
		console.log(`Storing on ${closestNodes.length} closest nodes to key ${key}:`, 
			closestNodes.map(n => ({ 
			nodeId: n.nodeId, 
			port: n.port, 
			distance: XOR(n.nodeId, key) 
			}))
		);
		
		if (closestNodes.length === 0 || !closestNodes.find(n => n.nodeId === this.node.nodeId)) {
			const selfDistance = XOR(this.node.nodeId, key);
			const shouldStoreLocally = closestNodes.length < 3 || 
			closestNodes.some(n => XOR(n.nodeId, key) > selfDistance);
			
			if (shouldStoreLocally) {
			console.log(`Also storing locally on node ${this.node.nodeId}, value: ${value?.substring(0, 50)}...`);
			await this.node.table.nodeStore(key.toString(), value);
			}
		}
		
		const closestNodesChunked = chunk<Peer>(closestNodes, ALPHA);

		for (const nodes of closestNodesChunked) {
			try {
			const promises = this.node.sendManyUdp(nodes, MessageType.Store, {
				key,
				value,
			});
			const results = await Promise.all(promises);
			console.log(`Store operation completed on ${results.length} nodes`);
			return results;
			} catch (e) {
			console.error(e);
			}
		}
    }

    /**
     * Secure store operation with encryption
     */
    public async secureStore(key: number, value: string): Promise<any> {
		console.log(`Node ${this.node.nodeId} initiating secure store for key ${key}`);
		
		const closestNodes = this.node.table.findNode(key, 3);
		
		const storePromises = closestNodes.map(async (node) => {
			// Prepare encrypted message
			const securePayload = this.node.secureMessageHandler.prepareMessage(
			{ key, value },
			node.nodeId
			);
			
			const payload = {
			resId: v4(),
			key,
			value,
			securePayload
			};
			
			const to = new Peer(node.nodeId, this.node.address, node.port);
			const message = NodeUtils.createUdpMessage(
			MessageType.Store,
			payload,
			this.node.nodeContact,
			to
			);
			
			return this.node.udpTransport.sendMessage(message, this.node.udpMessageResolver);
		});
		
		const results = await Promise.allSettled(storePromises);
		const successful = results.filter(r => r.status === 'fulfilled').length;
		
		console.log(`Secure store completed on ${successful}/${closestNodes.length} nodes`);
		return results;
    }

    /**
     * Find value operation
     */
    public async findValue(value: string): Promise<FindValueResponse | null> {
		const key = hashKeyAndmapToKeyspace(value);
		console.log(`Node ${this.node.nodeId} looking for value "${value}" with key ${key}`);
		
		const localValue = await this.node.table.findValue(key.toString());
		if (typeof localValue === 'string') {
			console.log(`Found value locally on node ${this.node.nodeId}`);
			return {
			value: localValue,
			nodeInfo: {
				nodeId: this.node.nodeId,
				address: this.node.address,
				port: this.node.port
			}
			};
		}
		
		const closestNodes = this.node.table.findNode(key, 20);
		
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
				console.log(`Querying node ${node.nodeId} at port ${node.port} (distance: ${XOR(node.nodeId, key)})`);
				const result = await this.sendSingleFindValue(node, key);
				if (result) {
				console.log(`Found value "${result}" at node ${node.nodeId} (port ${node.port})`);
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
     * Send single find value request
     */
    private async sendSingleFindValue(node: Peer, key: number): Promise<string | null> {
		try {
			const to = new Peer(node.nodeId, this.node.address, node.port);
			
			let payload: any = { 
			resId: v4(), 
			key 
			};

			// Always add key exchange if we don't have their key
			const hasTheirKey = !!this.node.cryptoManager.getStoredPublicKey(node.nodeId);
			if (!hasTheirKey) {
			payload.keyExchange = {
				nodeId: this.node.nodeId,
				publicKey: this.node.cryptoManager.getPublicKey(),
				timestamp: Date.now(),
				requestType: 'offer' as const
			};
			console.log(`Adding key exchange offer to FindValue request for node ${node.nodeId}`);
			}

			// Add encryption if we have their key
			if (this.node.encryptionEnabled && hasTheirKey) {
			try {
				const securePayload = this.node.secureMessageHandler.prepareMessage(
				{ key },
				node.nodeId
				);
				payload.securePayload = securePayload;
				console.log(`Encrypting FindValue request to node ${node.nodeId}`);
			} catch (error) {
				console.warn(`Failed to encrypt FindValue request to node ${node.nodeId}:`, error.message);
			}
			} else {
			console.log(`Sending unencrypted FindValue request to node ${node.nodeId} (encryption: ${this.node.encryptionEnabled}, hasKey: ${hasTheirKey})`);
			}

			const message = NodeUtils.createUdpMessage(MessageType.FindValue, payload, this.node.nodeContact, to);
			
			console.log(`Sending FindValue request to node ${node.nodeId} for key ${key}`);
			
			const result = await this.node.udpTransport.sendMessage(message, this.node.udpMessageResolver);
			
			console.log(`Received response from node ${node.nodeId}:`, {
			resultType: typeof result,
			isString: typeof result === 'string',
			length: typeof result === 'string' ? (result as string).length : 'N/A',
			encrypted: !!(payload.securePayload),
			preview: typeof result === 'string' ? (result as string).substring(0, 100) : String(result)
			});
			
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

	    /**
     * Secure ping operation
     */
    public async securePing(nodeId: number, address: string, port: number): Promise<boolean> {
		return new Promise((resolve) => {
			const to = new Peer(nodeId, address, port);
			const payload = { 
			resId: v4(),
			keyExchange: {
				nodeId: this.node.nodeId,
				publicKey: this.node.cryptoManager.getPublicKey(),
				timestamp: Date.now(),
				requestType: 'offer' as const
			}
			};
			
			const message = NodeUtils.createUdpMessage(MessageType.Ping, payload, this.node.nodeContact, to);
			
			const timeoutId = setTimeout(() => {
			this.node.emitter.removeAllListeners(`response_pong_${payload.resId}`);
			resolve(false);
			}, 2000);
			
			this.node.emitter.once(`response_pong_${payload.resId}`, () => {
			clearTimeout(timeoutId);
			resolve(true);
			});
			
			this.node.udpTransport.server.send(
			require('msgpackr').pack(message),
			port,
			address,
			(err) => {
				if (err) {
				clearTimeout(timeoutId);
				this.node.emitter.removeAllListeners(`response_pong_${payload.resId}`);
				resolve(false);
				}
			}
			);
		});
    }

    /**
     * Trigger key exchange with all peers
     */
    public async triggerKeyExchangeWithAllPeers(): Promise<void> {
		const allPeers = this.node.table.getAllPeers();
		console.log(`Triggering key exchange with ${allPeers.length} peers`);
		
		const pingPromises = allPeers.map(peer => 
			this.securePing(peer.nodeId, peer.address, peer.port)
		);
		
		const results = await Promise.allSettled(pingPromises);
		const successful = results.filter(r => r.status === 'fulfilled' && r.value).length;
		
		console.log(`Key exchange completed with ${successful}/${allPeers.length} peers`);
		console.log(`Now have ${this.node.cryptoManager.getAllKnownKeys().length} public keys`);
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
			encryptionEnabled: this.node.encryptionEnabled,
			knownKeys: this.node.cryptoManager.getAllKnownKeys().length,
			publicKeyFingerprint: this.node.getPublicKeyFingerprint(),
			keyDiscoveryRequests: this.node.keyDiscoveryManager.getDiscoveredKeys().length
		};
    }

    /**
     * Register as gateway
     */
    public async registerAsGateway(
      blockchainId: string,
      endpoint: string,
      pubKey?: string
    ): Promise<GatewayInfo> {
		console.log(`Node ${this.node.nodeId} registering as gateway for ${blockchainId}${pubKey ? ` with pubKey: ${pubKey.substring(0, 20)}` : ''}`);
		
		const gatewayInfo = new GatewayInfo(
			blockchainId,
			this.node.nodeId,
			endpoint,
			pubKey
		);

		this.node.registeredGateways.set(blockchainId, gatewayInfo);

		const gatewayKey = hashKeyAndmapToKeyspace(`gw-${blockchainId}`);
		const specificKey = hashKeyAndmapToKeyspace(`gw-${blockchainId}-${this.node.nodeId}`);
		
		console.log(`Storing with keys: Primary=${gatewayKey}, Specific=${specificKey}`);
		
		await Promise.allSettled([
			this.store(gatewayKey, gatewayInfo.serialize()),
			this.store(specificKey, gatewayInfo.serialize())
		]);
		
		console.log(`Gateway registration completed for ${blockchainId}`);
		return gatewayInfo;
    }

    /**
     * Register as gateway securely
     */
    public async registerAsGatewaySecure(
      blockchainId: string,
      endpoint: string,
      pubKey?: string
    ): Promise<GatewayInfo> {
		console.log(`Node ${this.node.nodeId} registering as gateway for ${blockchainId} (SECURE)${pubKey ? ` with pubKey: ${pubKey.substring(0, 20)}...` : ''}`);
		
		const gatewayInfo = new GatewayInfo(
			blockchainId,
			this.node.nodeId,
			endpoint,
			pubKey
		);

		// Store using secure method
		await this.storeGatewaySecure(gatewayInfo);
		
		console.log(`Secure gateway registration completed for ${blockchainId}`);
		return gatewayInfo;
    }

    /**
     * Store gateway securely
     */
    public async storeGatewaySecure(gatewayInfo: GatewayInfo): Promise<any> {
		console.log(`Node ${this.node.nodeId} storing gateway securely for ${gatewayInfo.blockchainId}`);
		
		// Store locally
		this.node.registeredGateways.set(gatewayInfo.blockchainId, gatewayInfo);
		
		// Generate storage keys
		const gatewayKey = hashKeyAndmapToKeyspace(`gw-${gatewayInfo.blockchainId}`);
		const specificKey = hashKeyAndmapToKeyspace(`gw-${gatewayInfo.blockchainId}-${this.node.nodeId}`);
		
		console.log(`Storing with keys: Primary=${gatewayKey}, Specific=${specificKey}`);
		
		// Store using secure method (uses encryption if keys available)
		const results = await Promise.allSettled([
			this.secureStore(gatewayKey, gatewayInfo.serialize()),
			this.secureStore(specificKey, gatewayInfo.serialize())
		]);
		
		const successful = results.filter(r => r.status === 'fulfilled').length;
		const failed = results.filter(r => r.status === 'rejected').length;
		
		console.log(`Secure gateway storage completed: ${successful} successful, ${failed} failed`);
		
		return results;
    }

    /**
     * Find gateways
     */
    public async findGateways(blockchainId: string): Promise<IGatewayInfo[]> {
		console.log(`\n=== Node ${this.node.nodeId} looking for gateways to ${blockchainId} ===`);
		
		const gateways: IGatewayInfo[] = [];
		const gatewayKey = hashKeyAndmapToKeyspace(`gw-${blockchainId}`);
		
		console.log(`Generated key: gw-${blockchainId} -> ${gatewayKey}`);
		
		if (this.node.registeredGateways.has(blockchainId)) {
			const localGateway = this.node.registeredGateways.get(blockchainId)!;
			console.log(`Found in local registered gateways`);
			gateways.push(localGateway);
		} else {
			console.log(`Not found in local registered gateways`);
		}
		
		console.log(`\n--- Checking local storage ---`);
		try {
			const localValue = await this.node.table.findValue(gatewayKey.toString());
			console.log(`Local storage result:`, {
			found: localValue !== undefined,
			type: typeof localValue,
			isString: typeof localValue === 'string',
			length: typeof localValue === 'string' ? localValue.length : 'N/A',
			preview: typeof localValue === 'string' ? localValue.substring(0, 100) : localValue
			});
			
			if (typeof localValue === 'string') {
			try {
				const gateway = GatewayInfo.deserialize(localValue);
				console.log(`Successfully parsed local gateway: ${gateway.blockchainId} (node ${gateway.nodeId})`);
				
				if (gateway.blockchainId === blockchainId && 
				!gateways.find(g => g.nodeId === gateway.nodeId)) {
				gateways.push(gateway);
				}
			} catch (parseError) {
				console.error(`Failed to parse local storage value:`, parseError.message);
			}
			}
		} catch (storageError) {
			console.error(`Error accessing local storage:`, storageError);
		}
		
		console.log(`\n--- Checking network with direct key lookup ---`);
		try {
			const closestNodes = this.node.table.findNode(gatewayKey, 10);
			console.log(`Querying ${closestNodes.length} nodes with key ${gatewayKey} directly`);
			
			for (const node of closestNodes) {
			try {
				const result = await this.sendSingleFindValue(node, gatewayKey);
				if (result && typeof result === 'string') {
				console.log(`Found gateway data from node ${node.nodeId}`);
				
				const gateway = GatewayInfo.deserialize(result);
				if (gateway.blockchainId === blockchainId && 
					!gateways.find(g => g.nodeId === gateway.nodeId)) {
					gateways.push(gateway);
					console.log(`Added gateway from network: ${gateway.blockchainId} (node ${gateway.nodeId})`);
				}
				break;
				}
			} catch (error) {
				console.log(`Error querying node ${node.nodeId}:`, error.message);
			}
			}
		} catch (networkError) {
			console.error(`Network search error:`, networkError);
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
		console.log(`\n=== Node ${this.node.nodeId} looking for gateways to ${blockchainId} (SECURE) ===`);
		
		const gateways: IGatewayInfo[] = [];
		const gatewayKey = hashKeyAndmapToKeyspace(`gw-${blockchainId}`);
		
		console.log(`Generated key: gw-${blockchainId} -> ${gatewayKey}`);
		
		// 1. Check local registered gateways
		if (this.node.registeredGateways.has(blockchainId)) {
			const localGateway = this.node.registeredGateways.get(blockchainId)!;
			console.log(`Found in local registered gateways`);
			gateways.push(localGateway);
		}
		
		// 2. Check local storage
		console.log(`\n--- Checking local storage ---`);
		try {
			const localValue = await this.node.table.findValue(gatewayKey.toString());
			if (typeof localValue === 'string') {
			try {
				const gateway = GatewayInfo.deserialize(localValue);
				console.log(`Successfully parsed local gateway: ${gateway.blockchainId} (node ${gateway.nodeId})`);
				
				if (gateway.blockchainId === blockchainId && 
				!gateways.find(g => g.nodeId === gateway.nodeId)) {
				gateways.push(gateway);
				}
			} catch (parseError) {
				console.error(`Failed to parse local storage value:`, parseError.message);
			}
			}
		} catch (storageError) {
			console.error(`Error accessing local storage:`, storageError);
		}
		
		// 3. Enhanced network search with encryption
		console.log(`\n--- Checking network with SECURE lookup ---`);
		try {
			const closestNodes = this.node.table.findNode(gatewayKey, 10);
			console.log(`Querying ${closestNodes.length} nodes with key ${gatewayKey} securely`);
			
			for (const node of closestNodes) {
			try {
				// Use encrypted findValue if we have the key
				const hasKey = !!this.node.cryptoManager.getStoredPublicKey(node.nodeId);
				if (hasKey) {
				console.log(`Using encrypted query for node ${node.nodeId}`);
				} else {
				console.log(`Using unencrypted query for node ${node.nodeId} (no key)`);
				}
				
				const result = await this.sendSingleFindValue(node, gatewayKey);
				if (result && typeof result === 'string') {
				console.log(`Found gateway data from node ${node.nodeId}`);
				
				const gateway = GatewayInfo.deserialize(result);
				if (gateway.blockchainId === blockchainId && 
					!gateways.find(g => g.nodeId === gateway.nodeId)) {
					gateways.push(gateway);
					console.log(`Added gateway from network: ${gateway.blockchainId} (node ${gateway.nodeId})`);
				}
				break;
				}
			} catch (error) {
				console.log(`Error querying node ${node.nodeId}:`, error.message);
			}
			}
		} catch (networkError) {
			console.error(`Network search error:`, networkError);
		}
		
		console.log(`\n=== SECURE Final result: ${gateways.length} gateway(s) for ${blockchainId} ===`);
		gateways.forEach((gw, i) => {
			console.log(`${i + 1}. ${gw.blockchainId} - node ${gw.nodeId} - ${gw.endpoint}`);
		});
		console.log(`================================================\n`);
		
		return gateways;
    }

    /**
     * Parse gateway data from storage
     */
    public parseGatewayData(data: string): IGatewayInfo[] {
		const gateways: IGatewayInfo[] = [];
		
		if (!data || typeof data !== 'string') {
			console.log('No data or invalid data type');
			return gateways;
		}
		
		try {
			const singleGateway = GatewayInfo.deserialize(data);
			gateways.push(singleGateway);
			console.log(`Parsed single gateway: ${singleGateway.blockchainId} (node ${singleGateway.nodeId})`);
			return gateways;
		} catch (singleError) {
			console.log(`Single JSON parse failed: ${singleError.message}`);
		}
		
		try {
			const parts = data.split('}{');
			
			if (parts.length === 1) {
			console.log('Single malformed JSON:', data.substring(0, 100));
			return gateways;
			}
			
			console.log(`Found ${parts.length} concatenated JSON parts`);
			
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
				const gateway = GatewayInfo.deserialize(jsonStr);
				gateways.push(gateway);
				console.log(`Parsed concatenated gateway ${i}: ${gateway.blockchainId} (node ${gateway.nodeId})`);
			} catch (parseError) {
				console.log(`Failed to parse JSON part ${i}: ${parseError.message}`);
				console.log(`Problematic JSON: ${jsonStr.substring(0, 100)}`);
			}
			}
		} catch (splitError) {
			console.error('Error parsing concatenated gateway data:', splitError);
		}
		
		return gateways;
    }
}