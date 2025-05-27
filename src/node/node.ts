import * as dgram from "dgram";
import { pack, unpack } from "msgpackr";
import { v4 } from "uuid";
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
  blockchainId?: string;  // Add for gateway queries
  gateways?: IGatewayInfo[];  // Add for gateway responses
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

	private readonly discScheduler: DiscoveryScheduler;
	constructor(id: number, port: number) {
		super(id, port, "kademlia");
		this.nodeContact = new Peer(this.nodeId, this.address, this.port);

		this.udpTransport = new UDPTransport(this.nodeId, this.port);
		this.wsTransport = new WebSocketTransport(this.nodeId, this.port);

		this.api = new App(this, this.port - 1000);
		this.table = new RoutingTable(this.nodeId, this);
		this.listen();
		this.discScheduler = new DiscoveryScheduler({ jobId: "discScheduler" });
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

	// node start function
	public start = async () => {
		// const clostest = getIdealDistance();
		await this.table.updateTables(new Peer(0, this.address, 3000));
		await this.initDiscScheduler();
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
			// this.handleTcpDisconnet(extractNumber(errorMessage) - 3000);
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
		console.log(`Node ${this.nodeId} initiating store for key ${key}, value: ${value}`);
		
		// Find the k-closest nodes to the key (not all peers)
		const closestNodes = this.table.findNode(key, 3); // Store on 3 closest nodes for redundancy
		
		console.log(`Storing on ${closestNodes.length} closest nodes to key ${key}:`, 
			closestNodes.map(n => ({ 
				nodeId: n.nodeId, 
				port: n.port, 
				distance: XOR(n.nodeId, key) 
			}))
		);
		
		// If no nodes found or only self, include self
		if (closestNodes.length === 0 || !closestNodes.find(n => n.nodeId === this.nodeId)) {
			// Also store locally if we're one of the closest
			const selfDistance = XOR(this.nodeId, key);
			const shouldStoreLocally = closestNodes.length < 3 || 
				closestNodes.some(n => XOR(n.nodeId, key) > selfDistance);
			
			if (shouldStoreLocally) {
				console.log(`Also storing locally on node ${this.nodeId}`);
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

	public async findValue(value: string): Promise<FindValueResponse | null> {
		const key = hashKeyAndmapToKeyspace(value);
		console.log(`Node ${this.nodeId} looking for value "${value}" with key ${key}`);
		
		// First check if we have it locally
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
		
		// Get the k-closest nodes to the key
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
				// Track which node we're querying
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
			const message = unpack(msg) as Message<StoreData>;
			const externalContact = message.from.nodeId;
			await this.table.updateTables(new Peer(message.from.nodeId, this.address, message.from.port));

			switch (message.type) {
				case MessageType.Store: {
					await this.table.nodeStore<StoreData>(message.data.data?.key, message.data.data?.value);
					await this.handleMessageResponse(MessageType.Pong, message, message.data?.data);
					break;
				}
				case MessageType.Ping: {
					this.udpTransport.messages.PING.set(message.data.data.resId, message);
					await this.handleMessageResponse(MessageType.Pong, message, message.data?.data);
					break;
				}
				case MessageType.Reply: {
					const resId = message.data.data.resId;
					this.udpTransport.messages.REPLY.set(message.data.data.resId, message);
					this.emitter.emit(`response_reply_${resId}`, { ...message.data?.data, error: null });
					break;
				}
				case MessageType.Pong: {
					const resId = message.data.data.resId;
					this.emitter.emit(`response_pong_${resId}`, { resId, error: null });
					break;
				}
				case MessageType.FoundResponse: {
					const m = (message as any).data.data;
					this.udpTransport.messages.REPLY.set(m.resId, message);
					this.emitter.emit(`response_findValue_${m.resId}`, { ...message, error: null });
					break;
				}
				case MessageType.FindNode: {
					const closestNodes = this.table.findNode(externalContact, ALPHA);
					const msgData = { resId: message.data.data.resId, closestNodes };

					this.udpTransport.messages.FIND_NODE.set(message.data.data.resId, message);
					await this.handleMessageResponse(MessageType.Reply, message, msgData);
					break;
				}
				case MessageType.FindValue: {
					const res = await this.table.findValue(message.data.data.key);
					const value = res;
					
					if (value) {
						console.log(`Node ${this.nodeId} found value for key ${message.data.data.key}: ${value}`);
					}
					
					await this.handleMessageResponse(MessageType.FoundResponse, message, { 
						resId: message.data.data.resId, 
						value 
					});
					break;
				}
				case MessageType.FindGateway: {
					const blockchainId = message.data.data?.blockchainId;
					if (!blockchainId) {
						console.error('FindGateway message missing blockchainId');
						break;
					}
					
					const localGateways: IGatewayInfo[] = [];
					
					// Check if we're a gateway for this blockchain
					if (this.registeredGateways.has(blockchainId)) {
						const gateway = this.registeredGateways.get(blockchainId)!;
						if (Date.now() - gateway.timestamp < 3600000) {
						localGateways.push(gateway);
						}
					}
					
					// Also check our storage
					const gatewayKey = hashKeyAndmapToKeyspace(`gateway:${blockchainId}`);
					const storedValue = await this.table.findValue(gatewayKey.toString());
					if (typeof storedValue === 'string') {
						try {
						const gateway = GatewayInfo.deserialize(storedValue);
						if (Date.now() - gateway.timestamp < 3600000 &&
							!localGateways.find(g => g.nodeId === gateway.nodeId)) {
							localGateways.push(gateway);
						}
						} catch (e) {
						// Invalid stored data
						}
					}
					
					const msgData = { 
						resId: message.data.data.resId, 
						gateways: localGateways
					};
					
					await this.handleMessageResponse(MessageType.GatewayResponse, message, msgData);
					break;
					}
					
					case MessageType.GatewayResponse: {
					const resId = message.data.data.resId;
					this.emitter.emit(`response_gateway_${resId}`, { ...message.data.data, error: null });
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
		resolve(data.data.data.value);
		});
	};

	private handleMessageResponse = async (type: MessageType, message: Message<StoreData>, data: any) => {
		const to = Peer.fromJSON(message.from.nodeId, message.from.address, message.from.port, message.from.lastSeen);
		const msg = NodeUtils.createUdpMessage(type, data, this.nodeContact, to);
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

		// if (bucket.nodes.length === 0) this.table.removeBucket();
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
			const payload = { resId: v4(), key };
			const message = NodeUtils.createUdpMessage(MessageType.FindValue, payload, this.nodeContact, to);
			const result = await this.udpTransport.sendMessage(message, this.udpMessageResolver);
			
			// Check if result is a string (the value we're looking for)
			if (typeof result === 'string') {
			return result;
			}
			
			return null;
		} catch (error) {
			console.error(`Error querying node ${node.nodeId}:`, error);
			return null;
		}
	}

	public debugClosestNodes(value: string) {
        const key = hashKeyAndmapToKeyspace(value);
        const allPeers = this.table.getAllPeers();
        
        allPeers.push(this.nodeContact);
        
        // Sort by XOR distance
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


	// Add gateway registration method
	public async registerAsGateway(
		blockchainId: string,
		endpoint: string,
		supportedProtocols: string[] = ['SATP']
	): Promise<GatewayInfo> {
		const gatewayInfo = new GatewayInfo(
		blockchainId,
		this.nodeId,
		endpoint,
		supportedProtocols
		);

		// Store locally
		this.registeredGateways.set(blockchainId, gatewayInfo);

		// Generate deterministic key for this blockchain's gateways
		const gatewayKey = hashKeyAndmapToKeyspace(`gateway:${blockchainId}`);
		
		console.log(`Node ${this.nodeId} registering as gateway for ${blockchainId}`);
		
		// Store in the DHT
		await this.store(gatewayKey, gatewayInfo.serialize());
		
		// Also store under a composite key for direct lookup
		const compositeKey = hashKeyAndmapToKeyspace(`gateway:${blockchainId}:${this.nodeId}`);
		await this.store(compositeKey, gatewayInfo.serialize());
		
		return gatewayInfo;
	}

	// Find gateways for a blockchain
	public async findGateways(blockchainId: string): Promise<IGatewayInfo[]> {
		console.log(`Node ${this.nodeId} looking for gateways to ${blockchainId}`);
		
		const gateways: IGatewayInfo[] = [];
		
		// Check if we are a gateway for this blockchain
		if (this.registeredGateways.has(blockchainId)) {
		const localGateway = this.registeredGateways.get(blockchainId)!;
		if (Date.now() - localGateway.timestamp < 3600000) { // 1 hour freshness
			gateways.push(localGateway);
		}
		}
		
		// Search the network using existing findValue
		const gatewayKey = hashKeyAndmapToKeyspace(`gateway:${blockchainId}`);
		const result = await this.findValue(gatewayKey.toString());
		
		if (result && result.value) {
		try {
			const gatewayInfo = GatewayInfo.deserialize(result.value);
			if (Date.now() - gatewayInfo.timestamp < 3600000 &&
				!gateways.find(g => g.nodeId === gatewayInfo.nodeId)) {
			gateways.push(gatewayInfo);
			}
		} catch (e) {
			console.error('Error deserializing gateway info:', e);
		}
		}
		
		// Query other nodes for more gateways
		const closestNodes = this.table.findNode(gatewayKey, 10);
		const additionalGateways = await this.queryNodesForGateways(blockchainId, closestNodes);
		
		// Merge results, avoiding duplicates
		for (const gateway of additionalGateways) {
		if (!gateways.find(g => g.nodeId === gateway.nodeId)) {
			gateways.push(gateway);
		}
		}
		
		console.log(`Found ${gateways.length} gateway(s) for ${blockchainId}`);
		return gateways;
	}

	private async queryNodesForGateways(blockchainId: string, nodes: Peer[]): Promise<IGatewayInfo[]> {
		const gatewayPromises = nodes.map(node => this.queryNodeForGateway(blockchainId, node));
		const results = await Promise.allSettled(gatewayPromises);
		
		const allGateways: IGatewayInfo[] = [];
		for (const result of results) {
			if (result.status === 'fulfilled' && result.value) {
			allGateways.push(...result.value);
			}
		}
		
		return allGateways;
	}

	private async queryNodeForGateway(blockchainId: string, node: Peer): Promise<IGatewayInfo[]> {
		return new Promise<IGatewayInfo[]>((resolve) => {
			const to = new Peer(node.nodeId, this.address, node.port);
			const payload = { resId: v4(), blockchainId };
			const message = NodeUtils.createUdpMessage(MessageType.FindGateway, payload, this.nodeContact, to);
			
			const timeoutId = setTimeout(() => {
				this.emitter.removeAllListeners(`response_gateway_${payload.resId}`);
				resolve([]);
			}, 2000);
			
			this.emitter.once(`response_gateway_${payload.resId}`, (data: any) => {
				clearTimeout(timeoutId);
				if (!data.error && data.gateways) {
					resolve(data.gateways);
				} else {
					resolve([]);
				}
			});
			
			this.udpTransport.server.send(
			pack(message),
			message.to.port,
			this.address,
			(err) => {
				if (err) {
					console.error(`Error sending gateway query to node ${node.nodeId}:`, err);
					clearTimeout(timeoutId);
					this.emitter.removeAllListeners(`response_gateway_${payload.resId}`);
					resolve([]);
				}
			}
			);
		});
	}

	// Start periodic refresh
	public startGatewayHeartbeat(blockchainId: string, endpoint: string, interval: number = 300000): void {
		this.gatewayHeartbeat = setInterval(async () => {
		console.log(`Refreshing gateway registration for ${blockchainId}`);
		await this.registerAsGateway(blockchainId, endpoint);
		}, interval);
	}

	public stopGatewayHeartbeat(): void {
		if (this.gatewayHeartbeat) {
		clearInterval(this.gatewayHeartbeat);
		this.gatewayHeartbeat = undefined;
		}
	}

	public async bootstrap(nodes: Array<{nodeId: number, address: string, port: number}>): Promise<void> {
		console.log(`Node ${this.nodeId} bootstrapping with ${nodes.length} node(s)`);
		
		for (const node of nodes) {
			try {
			// Add node to routing table
			const peer = new Peer(node.nodeId, node.address, node.port);
			await this.table.updateTables(peer);
			
			// Send a ping to establish contact
			await this.ping(node.nodeId, node.address, node.port);
			
			console.log(`Node ${this.nodeId} successfully connected to bootstrap node ${node.nodeId}`);
			} catch (error) {
			console.error(`Failed to connect to bootstrap node ${node.nodeId}:`, error);
			}
		}
		
		// Perform initial node discovery
		await this.findNodes(this.nodeId);
	}

	/**
	 * Ping a specific node to check if it's alive and add it to routing table
	 */
	public async ping(nodeId: number, address: string, port: number): Promise<boolean> {
		return new Promise((resolve) => {
			const to = new Peer(nodeId, address, port);
			const payload = { resId: v4() };
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

	/**
	 * Gracefully stop the node and clean up resources
	 */
	public async stop(): Promise<void> {
		console.log(`Stopping node ${this.nodeId}...`);
		
		try {
			// Stop gateway heartbeat
			this.stopGatewayHeartbeat();
			
			// Stop discovery scheduler
			if (this.discScheduler) {
			this.discScheduler.stopCronJob();
			}
			
			// Remove all event listeners
			if (this.emitter) {
			this.emitter.removeAllListeners();
			}
			
			// Close UDP server
			if (this.udpTransport && this.udpTransport.server) {
			await new Promise<void>((resolve) => {
				// dgram.Socket.close() only takes a callback with no parameters
				this.udpTransport.server.close(() => {
				resolve();
				});
			});
			}
			
			// Close all WebSocket connections
			if (this.wsTransport) {
			// Close all active connections
			if (this.wsTransport.connections) {
				this.wsTransport.connections.clear();
			}
			if (this.wsTransport.neighbors) {
				this.wsTransport.neighbors.clear();
			}
			
			// Close the server
			if (this.wsTransport.server) {
				await new Promise<void>((resolve) => {
				this.wsTransport.server.close(() => {
					resolve();
				});
				});
			}
			}
			
			// Close HTTP API server
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

	/**
	 * Get current status of the node
	 */
	public getStatus(): {
		nodeId: number;
		port: number;
		httpPort: number;
		peers: number;
		buckets: number;
		registeredGateways: string[];
		} {
		return {
			nodeId: this.nodeId,
			port: this.port,
			httpPort: this.port - 1000,
			peers: this.table.getAllPeers().length,
			buckets: this.table.getAllBucketsLen(),
			registeredGateways: Array.from(this.registeredGateways.keys())
		};
	}
}

export default KademliaNode;
