import * as dgram from "dgram";
import { pack, unpack } from "msgpackr";
import { v4 } from "uuid";
import { KeyDiscoveryManager } from '../crypto/keyDiscovery';
import { CryptoManager } from '../crypto/keyManager';
import { SecureMessageHandler } from '../crypto/secureMessage';
import { DiscoveryScheduler } from "../discoveryScheduler/discoveryScheduler";
import { GatewayInfo, IGatewayInfo } from "../gateway/gateway";
import { App } from "../http/app";
import { Message, MessagePayload, UDPDataInfo } from "../message/message";
import { Peer, PeerJSON } from "../peer/peer";
import RoutingTable from "../routingTable/routingTable";
import WebSocketTransport from "../transports/tcp/wsTransport";
import UDPTransport from "../transports/udp/udpTransport";
import { MessageType, PacketType, Transports } from "../types/messageTypes";
import { BroadcastData, DirectData, TcpPacket } from "../types/udpTransportTypes";
import { extractError } from "../utils/extractError";
import { chunk, hashKeyAndmapToKeyspace, XOR } from "../utils/nodeUtils";
import AbstractNode from "./abstractNode/abstractNode";
import { ALPHA, BIT_SIZE } from "./constants";
import { NodeUtils } from "./nodeUtils";

interface FindValueResponse {
  value: string | null;
  nodeInfo?: {
    nodeId: number;
    address: string;
    port: number;
  };
}

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

class KademliaNode extends AbstractNode {
	public readonly nodeContact: Peer;
	public readonly table: RoutingTable;
	public readonly contacted = new Map<string, number>();
	public readonly api: App;

	public readonly udpTransport: UDPTransport;
	public readonly wsTransport: WebSocketTransport;

	private gatewayHeartbeat?: NodeJS.Timeout;
  	private registeredGateways: Map<string, GatewayInfo> = new Map();

	private cryptoManager: CryptoManager;
	private secureMessageHandler: SecureMessageHandler;
	private keyDiscoveryManager: KeyDiscoveryManager;
	private encryptionEnabled: boolean = true;

	public getRegisteredGateways(): ReadonlyMap<string, GatewayInfo> {
  		return this.registeredGateways;
	}

	private readonly discScheduler: DiscoveryScheduler;
	
	constructor(id: number, port: number) {
		super(id, port, "kademlia");
		this.nodeContact = new Peer(this.nodeId, this.address, this.port);

		// Initialize crypto components
		this.cryptoManager = new CryptoManager();
		this.secureMessageHandler = new SecureMessageHandler(this.cryptoManager);
		this.keyDiscoveryManager = new KeyDiscoveryManager(this.cryptoManager, id);
		this.encryptionEnabled = true;

		this.udpTransport = new UDPTransport(this.nodeId, this.port);
		this.wsTransport = new WebSocketTransport(this.nodeId, this.port);

		this.api = new App(this, this.port - 1000);
		this.table = new RoutingTable(this.nodeId, this);
		this.listen();
		this.discScheduler = new DiscoveryScheduler({ jobId: "discScheduler" });

		console.log(`Node ${id} initialized with encryption support`);
		console.log(`Public key fingerprint: ${this.getPublicKeyFingerprint()}`);
	}

	// register transport listeners
	public listen = (cb?: any): ((cb?: any) => void) => {
		this.udpTransport.onMessage(this.handleMessage);
		this.wsTransport.onMessage(this.handleBroadcastMessage, PacketType.Broadcast);
		this.wsTransport.onMessage(this.handleDirectMessage, PacketType.Direct);

		this.wsTransport.onPeerDisconnect(this.handleTcpDisconnet);
		this.wsTransport.onPeerConnection(() => null);
		this.api.listen();

		return (cb) => this.wsTransport.server.close(cb);
	};

	public start = async () => {
		await this.table.updateTables(new Peer(0, this.address, 3000));
		await this.initDiscScheduler();

		// Store our public key in DHT
		try {
			await this.keyDiscoveryManager.storeOwnKeyInDHT(
				(key, value) => this.store(key, value)
			);
			console.log(`Node ${this.nodeId} public key stored in DHT`);
		} catch (error) {
			console.error(`Failed to store public key in DHT:`, error);
		}

		// Start crypto maintenance
		this.startCryptoMaintenance();
	};

	public async initDiscScheduler() {
		this.discScheduler.createSchedule(this.discScheduler.schedule, async () => {
			try {
				const closeNodes = await this.findNodes(this.nodeId);
				await this.table.updateTables(closeNodes);
				const routingPeers = this.table.getAllPeers();

				await this.updatePeerDiscoveryInterval(routingPeers);
				await this.refreshAndUpdateConnections(routingPeers);
			} catch (error) {
				this.log.error(`message: ${extractError(error)}, fn: executeCronTask`);
			}
		});
	}

	private findNodes = async (key: number): Promise<Peer[]> => {
		const contacts = new Map<string, Peer>();
		const shortlist = this.table.findNode(key, ALPHA);

		const closeCandidate = shortlist[0];
		let iteration: number = null;
		await this.findNodeRecursiveSearch(contacts, shortlist, closeCandidate, iteration);
		return Array.from(contacts.values());
	};

	private handleFindNodeQuery = async (contacts: Map<string, Peer>, node: Peer, nodeShortlist: Peer[], candidate: Peer) => {
		let hasCloserThanExist = false;
		try {
			const to = node.toJSON();
			const data = { resId: v4() };
			const message = NodeUtils.createUdpMessage(MessageType.FindNode, data, this.nodeContact, to);
			const findNodeResponse = this.udpTransport.sendMessage(message, this.udpMessageResolver);
			const closeNodes = await Promise.resolve(findNodeResponse);

			let initialClosestNode = candidate;
			contacts.set(node.nodeId.toString(), node);

			for (const currentCloseNode of closeNodes) {
				nodeShortlist.push(currentCloseNode);

				const currentDistance = this.table.getBucketIndex(initialClosestNode.nodeId);
				const distance = this.table.getBucketIndex(currentCloseNode.nodeId);

				if (distance < currentDistance) {
					initialClosestNode = currentCloseNode;
					hasCloserThanExist = true;
				}
			}
		} catch (e) {
			const errorMessage = extractError(e);
			this.log.info(`message: ${errorMessage}, fn: handleFindNodeQuery`);
		}
		return hasCloserThanExist;
	};

	private findNodeRecursiveSearch = async (contacts: Map<string, Peer>, nodeShortlist: Peer[], candidate: Peer, iteration: number) => {
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
	};

	public async store(key: number, value: string) {
		console.log(`Node ${this.nodeId} initiating store for key ${key}, value type: ${typeof value}, value: ${value?.substring(0, 100)}...`);
  
		if (typeof value !== 'string') {
			console.error(`Store method received non-string value:`, value);
			value = typeof value === 'object' ? JSON.stringify(value) : String(value);
		}
		
		const closestNodes = this.table.findNode(key, 3);
		
		console.log(`Storing on ${closestNodes.length} closest nodes to key ${key}:`, 
			closestNodes.map(n => ({ 
			nodeId: n.nodeId, 
			port: n.port, 
			distance: XOR(n.nodeId, key) 
			}))
		);
		
		if (closestNodes.length === 0 || !closestNodes.find(n => n.nodeId === this.nodeId)) {
			const selfDistance = XOR(this.nodeId, key);
			const shouldStoreLocally = closestNodes.length < 3 || 
			closestNodes.some(n => XOR(n.nodeId, key) > selfDistance);
			
			if (shouldStoreLocally) {
			console.log(`Also storing locally on node ${this.nodeId}, value: ${value?.substring(0, 50)}...`);
			await this.table.nodeStore(key.toString(), value);
			}
		}
		
		const closestNodesChunked = chunk<Peer>(closestNodes, ALPHA);

		for (const nodes of closestNodesChunked) {
			try {
			const promises = this.sendManyUdp(nodes, MessageType.Store, {
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

	// Enhanced secure store method
	public async secureStore(key: number, value: string): Promise<any> {
		console.log(`Node ${this.nodeId} initiating secure store for key ${key}`);
		
		const closestNodes = this.table.findNode(key, 3);
		
		const storePromises = closestNodes.map(async (node) => {
			// Prepare encrypted message
			const securePayload = this.secureMessageHandler.prepareMessage(
				{ key, value },
				node.nodeId
			);
			
			const payload = {
				resId: v4(),
				key,
				value,
				securePayload
			};
			
			const to = new Peer(node.nodeId, this.address, node.port);
			const message = NodeUtils.createUdpMessage(
				MessageType.Store,
				payload,
				this.nodeContact,
				to
			);
			
			return this.udpTransport.sendMessage(message, this.udpMessageResolver);
		});
		
		const results = await Promise.allSettled(storePromises);
		const successful = results.filter(r => r.status === 'fulfilled').length;
		
		console.log(`Secure store completed on ${successful}/${closestNodes.length} nodes`);
		return results;
	}

	public async findValue(value: string): Promise<FindValueResponse | null> {
		const key = hashKeyAndmapToKeyspace(value);
		console.log(`Node ${this.nodeId} looking for value "${value}" with key ${key}`);
		
		const localValue = await this.table.findValue(key.toString());
		if (typeof localValue === 'string') {
			console.log(`Found value locally on node ${this.nodeId}`);
			return {
				value: localValue,
				nodeInfo: {
					nodeId: this.nodeId,
					address: this.address,
					port: this.port
				}
			};
		}
		
		const closestNodes = this.table.findNode(key, 20);
		
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

	public handleMessage = async (msg: Buffer, info: dgram.RemoteInfo) => {
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
					const decryptedData = this.secureMessageHandler.processMessage(
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
					// Could choose to reject message or handle as unencrypted
					return;
				}
			}

			const externalContact = processedMessage.from.nodeId;
			await this.table.updateTables(new Peer(processedMessage.from.nodeId, this.address, processedMessage.from.port));

			switch (processedMessage.type) {
				case MessageType.Store: {
					const key = processedMessage.data.data?.key;
					const value = processedMessage.data.data?.value;
					
					console.log(`Node ${this.nodeId} received STORE message:`, {
						key,
						valueType: typeof value,
						valueLength: value?.length,
						encrypted: !!rawMessage.data.data?.securePayload,
						valuePreview: value?.substring(0, 50) + (value?.length > 50 ? '...' : '')
					});
					
					if (typeof value === 'string') {
						await this.table.nodeStore<StoreData>(key, value);
					} else {
						console.error(`Received non-string value in STORE message:`, value);
						const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
						await this.table.nodeStore<StoreData>(key, stringValue);
					}
					
					await this.handleMessageResponse(MessageType.Pong, processedMessage, processedMessage.data?.data);
					break;
				}
				case MessageType.Ping: {
					this.udpTransport.messages.PING.set(processedMessage.data.data.resId, processedMessage);
					
					// Handle key exchange in ping
					if (processedMessage.data.data.keyExchange) {
						this.cryptoManager.storePublicKey(
							processedMessage.data.data.keyExchange.nodeId,
							processedMessage.data.data.keyExchange.publicKey
						);
						console.log(`Stored public key from node ${processedMessage.data.data.keyExchange.nodeId} via ping`);
					}
					
					// Send pong with our public key
					const responseData = {
						resId: processedMessage.data.data.resId,
						keyExchange: {
							nodeId: this.nodeId,
							publicKey: this.cryptoManager.getPublicKey(),
							timestamp: Date.now(),
							requestType: 'response' as const
						}
					};
					
					await this.handleMessageResponse(MessageType.Pong, processedMessage, responseData);
					break;
				}
				case MessageType.Reply: {
					const resId = processedMessage.data.data.resId;
					this.udpTransport.messages.REPLY.set(processedMessage.data.data.resId, processedMessage);
					this.emitter.emit(`response_reply_${resId}`, { ...processedMessage.data?.data, error: null });
					break;
				}
				case MessageType.Pong: {
					const resId = processedMessage.data.data.resId;
					
					// Handle key exchange in pong
					if (processedMessage.data.data.keyExchange) {
						this.cryptoManager.storePublicKey(
							processedMessage.data.data.keyExchange.nodeId,
							processedMessage.data.data.keyExchange.publicKey
						);
						console.log(`Stored public key from node ${processedMessage.data.data.keyExchange.nodeId} via pong`);
					}
					
					this.emitter.emit(`response_pong_${resId}`, { resId, error: null });
					break;
				}
				case MessageType.FoundResponse: {
					const m = (processedMessage as any).data.data;
					this.udpTransport.messages.REPLY.set(m.resId, processedMessage);
					this.emitter.emit(`response_findValue_${m.resId}`, { ...processedMessage, error: null });
					break;
				}
				case MessageType.FindNode: {
					const closestNodes = this.table.findNode(externalContact, ALPHA);
					const msgData = { resId: processedMessage.data.data.resId, closestNodes };

					this.udpTransport.messages.FIND_NODE.set(processedMessage.data.data.resId, processedMessage);
					await this.handleMessageResponse(MessageType.Reply, processedMessage, msgData);
					break;
				}
				case MessageType.FindValue: {
						// Handle key exchange first
					if (processedMessage.data.data.keyExchange) {
						const keyExchange = processedMessage.data.data.keyExchange;
						this.cryptoManager.storePublicKey(keyExchange.nodeId, keyExchange.publicKey);
						console.log(`Stored public key from node ${keyExchange.nodeId} via FindValue request`);
					}

					// Check if this is an encrypted request
					let searchKey = processedMessage.data.data.key;
					
					if (processedMessage.data.data?.securePayload) {
						console.log(`Received encrypted FindValue request from node ${externalContact}`);
					} else {
						console.log(`Received unencrypted FindValue request from node ${externalContact}`);
					}

					const res = await this.table.findValue(searchKey);
					const value = res;
					
					if (value && typeof value === 'string') {
						const displayValue = value.substring(0, 100);
						console.log(`Node ${this.nodeId} found value for key ${searchKey}: ${displayValue}${value.length > 100 ? '...' : ''}`);
					} else {
						console.log(`Node ${this.nodeId} did not find value for key ${searchKey}`);
					}
					
					// Create base response data
					let responseData: any = { 
						resId: processedMessage.data.data.resId, 
						value 
					};

					// Always add our key exchange in response
					responseData.keyExchange = {
						nodeId: this.nodeId,
						publicKey: this.cryptoManager.getPublicKey(),
						timestamp: Date.now(),
						requestType: 'response' as const
					};

					// If we have the sender's key, encrypt the response
					const hasSenderKey = !!this.cryptoManager.getStoredPublicKey(externalContact);
					if (this.encryptionEnabled && hasSenderKey) {
						try {
							const secureResponsePayload = this.secureMessageHandler.prepareMessage(
								{ resId: responseData.resId, value, keyExchange: responseData.keyExchange },
								externalContact
							);
							responseData.securePayload = secureResponsePayload;
							console.log(`Encrypting FindValue response to node ${externalContact}`);
						} catch (error) {
							console.warn(`Failed to encrypt FindValue response to node ${externalContact}:`, error.message);
						}
					} else {
						console.log(`Sending unencrypted FindValue response to node ${externalContact} (encryption: ${this.encryptionEnabled}, hasKey: ${hasSenderKey})`);
					}
					
					await this.handleMessageResponse(MessageType.FoundResponse, processedMessage, responseData);
					break;
				}
				case MessageType.FindGateway: {
						const blockchainId = processedMessage.data.data?.blockchainId;
						if (!blockchainId) {
							console.error('FindGateway message missing blockchainId');
							break;
						}
						
						console.log(`Node ${this.nodeId} received FindGateway request for ${blockchainId}`);
						
						const localGateways: IGatewayInfo[] = [];
						
						if (this.registeredGateways.has(blockchainId)) {
							const gateway = this.registeredGateways.get(blockchainId)!;
							if (Date.now() - gateway.timestamp < 3600000) {
								localGateways.push(gateway);
								console.log(`Found local registered gateway for ${blockchainId}`);
							}
						}
						
						const gatewayKey = hashKeyAndmapToKeyspace(`gw-${blockchainId}`);
						console.log(`Checking local storage for key: ${gatewayKey}`);
						
						const storedValue = await this.table.findValue(gatewayKey.toString());
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
							resId: processedMessage.data.data.resId, 
							gateways: localGateways
						};
						
						await this.handleMessageResponse(MessageType.GatewayResponse, processedMessage, msgData);
						break;
				}
				default:
					return;
			}
		} catch (e) {
			const errorMessage = extractError(e);
			this.log.error(errorMessage);
		}
	};

	// Handle key discovery messages
	private async handleKeyDiscoveryMessage(message: any): Promise<void> {
		const keyExchange = message.data.data.keyExchange;
		const senderNodeId = message.from.nodeId;
		
		if (keyExchange.requestType === 'request') {
			// Store sender's public key
			this.cryptoManager.storePublicKey(senderNodeId, keyExchange.publicKey);
			console.log(`Received key discovery request from node ${senderNodeId}`);
			
			// Send our key back
			const responsePayload = {
				resId: message.data.data.resId,
				keyExchange: {
					nodeId: this.nodeId,
					publicKey: this.cryptoManager.getPublicKey(),
					timestamp: Date.now(),
					requestType: 'response'
				}
			};
			
			const to = new Peer(senderNodeId, this.address, message.from.port);
			const responseMessage = NodeUtils.createUdpMessage(
				'KEY_RESPONSE' as any,
				responsePayload,
				this.nodeContact,
				to
			);
			
			await this.udpTransport.sendMessage(responseMessage, this.udpMessageResolver);
			
		} else if (keyExchange.requestType === 'response') {
			// Store received public key
			this.cryptoManager.storePublicKey(senderNodeId, keyExchange.publicKey);
			console.log(`Received public key from node ${senderNodeId} via key discovery`);
		}
	}

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
				const nodes = data.closestNodes.map((node: PeerJSON) => Peer.fromJSON(node.nodeId, this.address, node.port, node.lastSeen));
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
			
			if (data && data.data && data.data.data && data.data.data.keyExchange) {
				const keyExchange = data.data.data.keyExchange;
				this.cryptoManager.storePublicKey(keyExchange.nodeId, keyExchange.publicKey);
				console.log(`Stored public key from node ${keyExchange.nodeId} via FindValue response`);
			}
			
			console.log(`Processing findValue response:`, {
				hasData: !!data,
				dataType: typeof data,
				hasDataData: !!(data && data.data),
				hasValue: !!(data && data.data && data.data.data && data.data.data.value),
				encrypted: !!(data && data.data && data.data.data && data.data.data.securePayload),
				rawValue: data && data.data && data.data.data ? data.data.data.value : 'not found'
			});
			
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

	// Enhanced message response with potential encryption
	private handleMessageResponse = async (type: MessageType, originalMessage: Message<StoreData>, data: any) => {
		const to = Peer.fromJSON(originalMessage.from.nodeId, originalMessage.from.address, originalMessage.from.port, originalMessage.from.lastSeen);
		
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
		
		const msg = NodeUtils.createUdpMessage(type, responseData, this.nodeContact, to);
		await this.udpTransport.sendMessage(msg, this.udpMessageResolver);
	};

	public sendTcpTransportMessage = <T extends BroadcastData | DirectData>(type: MessageType, payload: T) => {
		const message = NodeUtils.creatTcpMessage<T>(type, payload, this.nodeContact, this.nodeContact);
		this.wsTransport.sendMessage<T>(message);
	};

	public sendManyUdp = (nodes: Peer[], type: MessageType, data?: any) => {
		return nodes.map((node: Peer) => {
			const to = new Peer(node.nodeId, this.address, node.port);
			const payload = { resId: v4(), ...data };
			
			// Add key exchange if we don't have their key
			if (!this.cryptoManager.getStoredPublicKey(node.nodeId)) {
				payload.keyExchange = {
					nodeId: this.nodeId,
					publicKey: this.cryptoManager.getPublicKey(),
					timestamp: Date.now(),
					requestType: 'offer'
				};
				console.log(`Adding key exchange offer to ${type} message for node ${node.nodeId}`);
			}

			// Add encryption if possible
			if (this.shouldUseEncryption(node.nodeId)) {
				try {
					const securePayload = this.secureMessageHandler.prepareMessage(
						{ ...data },
						node.nodeId
					);
					payload.securePayload = securePayload;
					console.log(`Encrypting ${type} message to node ${node.nodeId}`);
				} catch (error) {
					console.warn(`Failed to encrypt ${type} message to node ${node.nodeId}:`, error.message);
				}
			}
			
			const message = NodeUtils.createUdpMessage(type, payload, this.nodeContact, to);
			return this.udpTransport.sendMessage(message, this.udpMessageResolver);
		});
	};

	public getTransportMessages = (transport: Transports, type: MessageType) => {
		switch (transport) {
			case Transports.Tcp:
				return this.wsTransport.messages[type];
			case Transports.Udp:
				return this.udpTransport.messages[type];
			default:
				this.log.error("No messages for this transport or type");
		}
	};

	protected createTcpMessage = <T extends BroadcastData | DirectData>(to: PeerJSON, type: MessageType, payload: any) => {
		const from = this.nodeContact.toJSON();
		const packet = NodeUtils.buildPacket<T>(type, payload);
		return Message.create<TcpPacket<T>>(to, from, Transports.Tcp, packet, type);
	};

	public handleBroadcastMessage = async () => {
		console.log(`recieveing broadcasting message: ${this.port}`);
	};

	public handleDirectMessage = async () => {
		console.log(`recieving direct message: ${this.port}`);
	};

	public handleTcpDisconnet = async (nodeId: number) => {
		this.wsTransport.connections.delete(nodeId.toString());
		this.wsTransport.neighbors.delete(nodeId.toString());

		if (this.nodeId === nodeId) return;
		const peer = new Peer(nodeId, this.address, nodeId + 3000);
		const bucket = this.table.findBucket(peer);
		bucket.removeNode(peer);
	};

	private updatePeerDiscoveryInterval = async (peers: Peer[]) => {
		const buckets = this.table.getAllBucketsLen();
		const isNteworkEstablished = NodeUtils.getIsNetworkEstablished(buckets, peers);

		const currentSchedule = this.discScheduler.schedule;
		const newSchedule = this.discScheduler.getNewSchedule(isNteworkEstablished);

		if (newSchedule !== currentSchedule) {
			this.discScheduler.setSchedule(newSchedule);
			this.discScheduler.stopCronJob();
			await this.initDiscScheduler();
			console.log(`setting disc interval to ${newSchedule}`);
		}
	};

	private refreshAndUpdateConnections = async (closestPeers: Peer[]) => {
		const ws = this.wsTransport;
		for (const peer of closestPeers) {
			const peerId = peer.nodeId.toString();

			if (!ws.connections.has(peerId)) {
				this.wsTransport.connect(peer.port, () => {
					console.log(`Connection from ${this.nodeId} to ${peer.port} established.`);
				});
			}
		}
	};
		
	private async sendSingleFindValue(node: Peer, key: number): Promise<string | null> {
		try {
			const to = new Peer(node.nodeId, this.address, node.port);
			
			let payload: any = { 
				resId: v4(), 
				key 
			};

			// Always add key exchange if we don't have their key
			const hasTheirKey = !!this.cryptoManager.getStoredPublicKey(node.nodeId);
			if (!hasTheirKey) {
				payload.keyExchange = {
					nodeId: this.nodeId,
					publicKey: this.cryptoManager.getPublicKey(),
					timestamp: Date.now(),
					requestType: 'offer' as const
				};
				console.log(`Adding key exchange offer to FindValue request for node ${node.nodeId}`);
			}

			// Add encryption if we have their key
			if (this.encryptionEnabled && hasTheirKey) {
				try {
					const securePayload = this.secureMessageHandler.prepareMessage(
						{ key },
						node.nodeId
					);
					payload.securePayload = securePayload;
					console.log(`Encrypting FindValue request to node ${node.nodeId}`);
				} catch (error) {
					console.warn(`Failed to encrypt FindValue request to node ${node.nodeId}:`, error.message);
				}
			} else {
				console.log(`Sending unencrypted FindValue request to node ${node.nodeId} (encryption: ${this.encryptionEnabled}, hasKey: ${hasTheirKey})`);
			}

			const message = NodeUtils.createUdpMessage(MessageType.FindValue, payload, this.nodeContact, to);
			
			console.log(`Sending FindValue request to node ${node.nodeId} for key ${key}`);
			
			const result = await this.udpTransport.sendMessage(message, this.udpMessageResolver);
			
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

	public debugClosestNodes(value: string) {
        const key = hashKeyAndmapToKeyspace(value);
        const allPeers = this.table.getAllPeers();
        
        allPeers.push(this.nodeContact);
        
        const sorted = allPeers.sort((a, b) => {
            const distA = XOR(a.nodeId, key);
            const distB = XOR(b.nodeId, key);
            return distA - distB;
        });
        
        console.log(`\nNodes sorted by distance to key ${key} (for value "${value}"):`);
        sorted.slice(0, 10).forEach((peer, index) => {
            const distance = XOR(peer.nodeId, key);
            const isSelf = peer.nodeId === this.nodeId ? " (THIS NODE)" : "";
            console.log(`${index + 1}. Node ${peer.nodeId} (port ${peer.port}) - XOR distance: ${distance}${isSelf}`);
        });
        
        return sorted.slice(0, 5).map(peer => ({
            nodeId: peer.nodeId,
            port: peer.port,
            distance: XOR(peer.nodeId, key)
        }));
    }

	// Gateway methods
	public async registerAsGateway(
		blockchainId: string,
		endpoint: string,
		pubKey?: string
	): Promise<GatewayInfo> {
		console.log(`Node ${this.nodeId} registering as gateway for ${blockchainId}${pubKey ? ` with pubKey: ${pubKey.substring(0, 20)}` : ''}`);
		
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
			this.store(gatewayKey, gatewayInfo.serialize()),
			this.store(specificKey, gatewayInfo.serialize())
		]);
		
		console.log(`Gateway registration completed for ${blockchainId}`);
		return gatewayInfo;
	}

	public async findGateways(blockchainId: string): Promise<IGatewayInfo[]> {
		console.log(`\n=== Node ${this.nodeId} looking for gateways to ${blockchainId} ===`);
		
		const gateways: IGatewayInfo[] = [];
		const gatewayKey = hashKeyAndmapToKeyspace(`gw-${blockchainId}`);
		
		console.log(`Generated key: gw-${blockchainId} -> ${gatewayKey}`);
		
		if (this.registeredGateways.has(blockchainId)) {
			const localGateway = this.registeredGateways.get(blockchainId)!;
			console.log(`Found in local registered gateways`);
			gateways.push(localGateway);
		} else {
			console.log(`Not found in local registered gateways`);
		}
		
		console.log(`\n--- Checking local storage ---`);
		try {
			const localValue = await this.table.findValue(gatewayKey.toString());
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
			const closestNodes = this.table.findNode(gatewayKey, 10);
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

	public startGatewayHeartbeat(blockchainId: string, endpoint: string, pubKey?: string, interval: number = 300000): void {
		this.gatewayHeartbeat = setInterval(async () => {
		console.log(`Refreshing gateway registration for ${blockchainId}`);
		await this.registerAsGateway(blockchainId, endpoint, pubKey);
		}, interval);
	}

	public stopGatewayHeartbeat(): void {
		if (this.gatewayHeartbeat) {
		clearInterval(this.gatewayHeartbeat);
		this.gatewayHeartbeat = undefined;
		}
	}

	// Enhanced bootstrap with key discovery
	public async bootstrap(nodes: Array<{nodeId: number, address: string, port: number}>): Promise<void> {
		console.log(`Node ${this.nodeId} starting secure bootstrap with ${nodes.length} node(s)`);
		
		for (const node of nodes) {
			try {
			const peer = new Peer(node.nodeId, node.address, node.port);
			await this.table.updateTables(peer);
			
			// Enhanced ping with key exchange
			await this.securePing(node.nodeId, node.address, node.port);
			
			console.log(`Node ${this.nodeId} successfully connected to bootstrap node ${node.nodeId}`);
			} catch (error) {
			console.error(`Failed to connect to bootstrap node ${node.nodeId}:`, error);
			}
		}
		
		// Perform key discovery
		await this.keyDiscoveryManager.discoverKeys(nodes);
		
		// Request keys for all known peers
		const allPeers = this.table.getAllPeers();
		for (const peer of allPeers) {
			await this.requestPeerKey(peer.nodeId);
		}
		
		await this.findNodes(this.nodeId);
		console.log(`Secure bootstrap completed. Known keys: ${this.cryptoManager.getAllKnownKeys().length}`);
	}

	// Enhanced ping with key exchange
	public async ping(nodeId: number, address: string, port: number): Promise<boolean> {
		return this.securePing(nodeId, address, port);
	}

	public async securePing(nodeId: number, address: string, port: number): Promise<boolean> {
		return new Promise((resolve) => {
			const to = new Peer(nodeId, address, port);
			const payload = { 
				resId: v4(),
				keyExchange: {
					nodeId: this.nodeId,
					publicKey: this.cryptoManager.getPublicKey(),
					timestamp: Date.now(),
					requestType: 'offer' as const
				}
			};
			
			const message = NodeUtils.createUdpMessage(MessageType.Ping, payload, this.nodeContact, to);
			
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

	// Request public key from a peer
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
			
			// If not in DHT, send direct key request
			await this.sendKeyDiscoveryRequest(peerNodeId);
		} catch (error) {
			console.error(`Failed to request key for node ${peerNodeId}:`, error);
		}
	}

	// Send key discovery request to a specific node
	private async sendKeyDiscoveryRequest(targetNodeId: number): Promise<void> {
		const peer = this.table.getAllPeers().find(p => p.nodeId === targetNodeId);
		if (!peer) {
			console.warn(`Cannot send key request to unknown node ${targetNodeId}`);
			return;
		}

		const requestId = v4();
		const keyExchangeData = {
			nodeId: this.nodeId,
			publicKey: this.cryptoManager.getPublicKey(),
			timestamp: Date.now(),
			requestType: 'request' as const
		};

		const payload = {
			resId: requestId,
			keyExchange: keyExchangeData
		};

		const to = new Peer(peer.nodeId, this.address, peer.port);
		const message = NodeUtils.createUdpMessage(
			'KEY_DISCOVERY' as any,
			payload,
			this.nodeContact,
			to
		);

		await this.udpTransport.sendMessage(message, this.udpMessageResolver);
	}

	public async stop(): Promise<void> {
		console.log(`Stopping node ${this.nodeId}...`);
		
		try {
			this.stopGatewayHeartbeat();
			
			if (this.discScheduler) {
			this.discScheduler.stopCronJob();
			}
			
			if (this.emitter) {
			this.emitter.removeAllListeners();
			}
			
			if (this.udpTransport && this.udpTransport.server) {
			await new Promise<void>((resolve) => {
				this.udpTransport.server.close(() => {
				resolve();
				});
			});
			}
			
			if (this.wsTransport) {
			if (this.wsTransport.connections) {
				this.wsTransport.connections.clear();
			}
			if (this.wsTransport.neighbors) {
				this.wsTransport.neighbors.clear();
			}
			
			if (this.wsTransport.server) {
				await new Promise<void>((resolve) => {
				this.wsTransport.server.close(() => {
					resolve();
				});
				});
			}
			}
			
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
			registeredGateways: Array.from(this.registeredGateways.keys()),
			encryptionEnabled: this.encryptionEnabled,
			knownKeys: this.cryptoManager.getAllKnownKeys().length,
			publicKeyFingerprint: this.getPublicKeyFingerprint()
		};
	}

	private parseGatewayData(data: string): IGatewayInfo[] {
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

	// === CRYPTO METHODS ===

	/**
	 * Get public key fingerprint for identification
	 */
	public getPublicKeyFingerprint(): string {
		const crypto = require('crypto');
		const publicKey = this.cryptoManager.getPublicKey();
		const hash = crypto.createHash('sha256').update(publicKey).digest('hex');
		return hash.substring(0, 16); // First 16 chars of hash
	}

	/**
	 * Enable/disable encryption
	 */
	public setEncryptionEnabled(enabled: boolean): void {
		this.encryptionEnabled = enabled;
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
	 * Manually add a public key (for testing or manual configuration)
	 */
	public addPublicKey(nodeId: number, publicKey: string): void {
		this.cryptoManager.storePublicKey(nodeId, publicKey);
		console.log(`Manually added public key for node ${nodeId}`);
	}

	/**
	 * Export keys for backup
	 */
	public exportKeys(): {
		keyPair: any;
		knownKeys: Array<{nodeId: number, publicKey: string, timestamp: number}>;
	} {
		return {
			keyPair: this.cryptoManager.exportKeyPair(),
			knownKeys: this.cryptoManager.getAllKnownKeys()
		};
	}

	/**
	 * Import keys from backup
	 */
	public importKeys(backup: {
		keyPair: any;
		knownKeys: Array<{nodeId: number, publicKey: string, timestamp: number}>;
	}): void {
		this.cryptoManager.importKeyPair(backup.keyPair);
		
		for (const keyInfo of backup.knownKeys) {
			this.cryptoManager.storePublicKey(keyInfo.nodeId, keyInfo.publicKey);
		}
		
		console.log(`Imported ${backup.knownKeys.length} public keys`);
	}

	/**
	 * Periodic maintenance for crypto system
	 */
	public startCryptoMaintenance(): void {
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

	public getCryptoManager(): CryptoManager {
		return this.cryptoManager;
	}

	public getKeyDiscoveryManager(): KeyDiscoveryManager {
		return this.keyDiscoveryManager;
	}

	private shouldUseEncryption(recipientNodeId: number): boolean {
		if (!this.encryptionEnabled) {
			return false;
		}
		const hasKey = !!this.cryptoManager.getStoredPublicKey(recipientNodeId);
		
		if (!hasKey) {
			console.log(`Encryption enabled but no key for node ${recipientNodeId}, sending unencrypted`);
		}
		
		return hasKey;
	}

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

	public async findGatewaysSecure(blockchainId: string): Promise<IGatewayInfo[]> {
		console.log(`\n=== Node ${this.nodeId} looking for gateways to ${blockchainId} (SECURE) ===`);
		
		const gateways: IGatewayInfo[] = [];
		const gatewayKey = hashKeyAndmapToKeyspace(`gw-${blockchainId}`);
		
		console.log(`Generated key: gw-${blockchainId} -> ${gatewayKey}`);
		
		// 1. Check local registered gateways
		if (this.registeredGateways.has(blockchainId)) {
			const localGateway = this.registeredGateways.get(blockchainId)!;
			console.log(`Found in local registered gateways`);
			gateways.push(localGateway);
		}
		
		// 2. Check local storage
		console.log(`\n--- Checking local storage ---`);
		try {
			const localValue = await this.table.findValue(gatewayKey.toString());
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
			const closestNodes = this.table.findNode(gatewayKey, 10);
			console.log(`Querying ${closestNodes.length} nodes with key ${gatewayKey} securely`);
			
			for (const node of closestNodes) {
				try {
					// Use encrypted findValue if we have the key
					const hasKey = !!this.cryptoManager.getStoredPublicKey(node.nodeId);
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

	public async storeGatewaySecure(gatewayInfo: GatewayInfo): Promise<any> {
		console.log(`Node ${this.nodeId} storing gateway securely for ${gatewayInfo.blockchainId}`);
		
		// Store locally
		this.registeredGateways.set(gatewayInfo.blockchainId, gatewayInfo);
		
		// Generate storage keys
		const gatewayKey = hashKeyAndmapToKeyspace(`gw-${gatewayInfo.blockchainId}`);
		const specificKey = hashKeyAndmapToKeyspace(`gw-${gatewayInfo.blockchainId}-${this.nodeId}`);
		
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

	// Enhanced registerAsGateway with secure storage
	public async registerAsGatewaySecure(
		blockchainId: string,
		endpoint: string,
		pubKey?: string
	): Promise<GatewayInfo> {
		console.log(`Node ${this.nodeId} registering as gateway for ${blockchainId} (SECURE)${pubKey ? ` with pubKey: ${pubKey.substring(0, 20)}...` : ''}`);
		
		const gatewayInfo = new GatewayInfo(
			blockchainId,
			this.nodeId,
			endpoint,
			pubKey
		);

		// Store using secure method
		await this.storeGatewaySecure(gatewayInfo);
		
		console.log(`Secure gateway registration completed for ${blockchainId}`);
		return gatewayInfo;
	}
}

export default KademliaNode;