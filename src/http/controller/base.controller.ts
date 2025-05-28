import { NextFunction, Request, Response } from "express";
import { GatewayInfo } from "../../gateway/gateway";
import KademliaNode from "../../node/node";
import { MessageType, Transports } from "../../types/messageTypes";
import { BroadcastData, DirectData } from "../../types/udpTransportTypes";
import { hashKeyAndmapToKeyspace } from "../../utils/nodeUtils";

class BaseController {
	public node: KademliaNode;

	constructor(node: KademliaNode) {
		this.node = node;
	}
	public ping = async (req: Request, res: Response, next: NextFunction) => {
		return res.json({ message: "succes" });
	};

	public getNodePeers = async (req: Request, res: Response, next: NextFunction) => {
		return res.json({ peers: this.node.table.getAllPeers() });
	};

	public getNodeBuckets = async (req: Request, res: Response, next: NextFunction) => {
		return res.json({ message: this.node.table.getAllBuckets() });
	};

	public postDirectMessage = (req: Request, res: Response, next: NextFunction) => {
		try {
			const payload: DirectData = {
				type: "direct-message",
				message: `recieved direct message from node ${this.node.port}`,
				to: Number(req.body.id),
			};
			this.node.sendTcpTransportMessage<DirectData>(MessageType.Braodcast, payload);
			res.send("success");
		} catch (error) {
			next(error);
		}
	};

	public postBroadcast = (req: Request, res: Response, next: NextFunction) => {
		try {
			const payload: BroadcastData = {
				type: "broadcast-message",
				message: `recieved broadcast message from node ${this.node.port}`,
				peers: [],
			};
			this.node.sendTcpTransportMessage<BroadcastData>(MessageType.Braodcast, payload);
			res.send("success");
		} catch (error) {
			next(error);
		}
	};

	public getNodeMessages = (req: Request, res: Response, next: NextFunction) => {
		try {
			const type = req.query.type as MessageType;
			const messagesMap = this.node.getTransportMessages(Transports.Tcp, type);
			const messages = Array.from(messagesMap.values());
			return res.json({ result: messages });
		} catch (error) {
			next(error);
		}
	};

	public getNodeUDPMessages = (req: Request, res: Response, next: NextFunction) => {
		try {
			const type = req.query.type as MessageType;
			const messagesMap = this.node.getTransportMessages(Transports.Udp, type);
			const messages = Array.from(messagesMap.values());
			return res.json({ result: messages });
		} catch (error) {
			next(error);
		}
	};

	public findClosestNode = (req: Request, res: Response, next: NextFunction) => {
		try {
			const closest = this.node.table.findClosestNode(Number(req.params.id));
			return res.json({ result: closest });
		} catch (error) {
			next(error);
		}
	};

	public storeValue = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const key = hashKeyAndmapToKeyspace(req.params.value);
			const closest = await this.node.store(key, req.params.value);
			return res.json({ result: closest, key });
		} catch (error) {
			next(error);
		}
	};

	public findValue = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const result = await this.node.findValue(req.params.key);
			
			if (result && result.value) {
			return res.json({
				found: true,
				value: result.value,
				nodeInfo: result.nodeInfo,
				message: `Value found on node ${result.nodeInfo.nodeId} at ${result.nodeInfo.address}:${result.nodeInfo.port}`
			});
			} else {
			return res.json({
				found: false,
				value: null,
				message: "Value not found in the network"
			});
			}
		} catch (error) {
			next(error);
		}
	};

	public debugClosestNodes = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const value = req.params.value;
			const closestNodes = this.node.debugClosestNodes(value);
			const key = hashKeyAndmapToKeyspace(value);
			
			return res.json({ 
				value,
				key,
				closestNodes,
				message: `Top nodes that should store "${value}" (key: ${key})`
			});
		} catch (error) {
			next(error);
		}
	};
	
	public registerGateway = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const { blockchainId, endpoint, protocols } = req.body;
			
			if (!blockchainId || !endpoint) {
			return res.status(400).json({ 
				error: 'blockchainId and endpoint are required' 
			});
			}
			
			const gatewayInfo = await this.node.registerAsGateway(
			blockchainId,
			endpoint,
			protocols || ['SATP']
			);
			
			// Start heartbeat
			this.node.startGatewayHeartbeat(blockchainId, endpoint);
			
			return res.json({
			success: true,
			gateway: gatewayInfo,
			message: `Node ${this.node.nodeId} registered as gateway for ${blockchainId}`
			});
		} catch (error) {
			next(error);
		}
		};

		public findGateways = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const { blockchainId } = req.params;
			
			if (!blockchainId) {
			return res.status(400).json({ 
				error: 'blockchainId is required' 
			});
			}
			
			const gateways = await this.node.findGateways(blockchainId);
			
			return res.json({
			blockchainId,
			gateways,
			count: gateways.length,
			message: gateways.length > 0 
				? `Found ${gateways.length} gateway(s) for ${blockchainId}`
				: `No gateways found for ${blockchainId}`
			});
		} catch (error) {
			next(error);
		}
	};

	/**
	 * POST /storeGateway
	 * Store gateway information manually via JSON payload
	 * 
	 * Example request body:
	 * {
	 *   "blockchainId": "ethereum",
	 *   "nodeId": 12345,
	 *   "endpoint": "http://gateway.example.com:8545",
	 *   "supportedProtocols": ["SATP", "ILP"]
	 * }
	*/
	public storeGateway = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const { blockchainId, nodeId, endpoint, supportedProtocols = ['SATP'] } = req.body;
			
			// Validate required fields
			if (!blockchainId || !nodeId || !endpoint) {
				return res.status(400).json({
					error: 'Missing required fields: blockchainId, nodeId, and endpoint are required'
				});
			}
			
			// Create gateway info object
			const gatewayInfo = new GatewayInfo(
				blockchainId,
				parseInt(nodeId),
				endpoint,
				Array.isArray(supportedProtocols) ? supportedProtocols : [supportedProtocols]
			);
			
			// Use unique keys to prevent mixing blockchains
			// Primary key: for finding all gateways of this blockchain
			const gatewayKey = hashKeyAndmapToKeyspace(`gw-${blockchainId}`);
			// Specific key: for this exact gateway instance
			const specificKey = hashKeyAndmapToKeyspace(`gw-${blockchainId}-${nodeId}`);
			
			console.log(`Manually storing gateway for ${blockchainId}, nodeId: ${nodeId}`);
			console.log(`Storage keys - Primary: ${gatewayKey}, Specific: ${specificKey}`);
			
			// Store using both keys
			const results = await Promise.allSettled([
				this.node.store(gatewayKey, gatewayInfo.serialize()),
				this.node.store(specificKey, gatewayInfo.serialize())
			]);
			
			const successful = results.filter(r => r.status === 'fulfilled').length;
			const failed = results.filter(r => r.status === 'rejected').length;
			
			return res.json({
				success: true,
				message: `Gateway stored successfully`,
				gateway: gatewayInfo,
				storage: {
					successful,
					failed,
					keys: {
						gatewayKey,
						specificKey
					}
				}
			});
			
		} catch (error) {
			console.error('Error storing gateway:', error);
			next(error);
		}
	};

	/**
	 * GET /storeGateway/:blockchainId/:nodeId/:endpoint
	 * Store gateway information via URL parameters (simpler for testing)
	 * 
	 * Example: GET /storeGateway/ethereum/12345/http%3A%2F%2Fgateway.example.com%3A8545
	 */
	public storeGatewaySimple = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const { blockchainId, nodeId, endpoint } = req.params;
			const { protocols } = req.query;
			
			// Parse protocols from query parameter
			let supportedProtocols = ['SATP']; // default
			if (protocols) {
				supportedProtocols = typeof protocols === 'string' 
					? protocols.split(',').map(p => p.trim())
					: Array.isArray(protocols) 
						? protocols.map(p => String(p).trim())
						: ['SATP'];
			}
			
			// Decode URL-encoded endpoint
			const decodedEndpoint = decodeURIComponent(endpoint);
			
			// Create gateway info object
			const gatewayInfo = new GatewayInfo(
				blockchainId,
				parseInt(nodeId),
				decodedEndpoint,
				supportedProtocols
			);
			
			// Use unique keys to prevent mixing blockchains
			const gatewayKey = hashKeyAndmapToKeyspace(`gw-${blockchainId}`);
			const specificKey = hashKeyAndmapToKeyspace(`gw-${blockchainId}-${nodeId}`);
			
			console.log(`Manually storing gateway via URL params:`);
			console.log(`- Blockchain: ${blockchainId}`);
			console.log(`- Node ID: ${nodeId}`);
			console.log(`- Endpoint: ${decodedEndpoint}`);
			console.log(`- Protocols: ${supportedProtocols.join(', ')}`);
			console.log(`- Keys: Primary=${gatewayKey}, Specific=${specificKey}`);
			
			// Store in DHT
			const results = await Promise.allSettled([
				this.node.store(gatewayKey, gatewayInfo.serialize()),
				this.node.store(specificKey, gatewayInfo.serialize())
			]);
			
			const successful = results.filter(r => r.status === 'fulfilled').length;
			const failed = results.filter(r => r.status === 'rejected').length;
			
			return res.json({
				success: true,
				message: `Gateway for ${blockchainId} stored successfully`,
				gateway: {
					blockchainId,
					nodeId: parseInt(nodeId),
					endpoint: decodedEndpoint,
					supportedProtocols,
					timestamp: gatewayInfo.timestamp
				},
				storage: {
					successful,
					failed,
					totalAttempts: 2,
					keys: {
						gatewayKey,
						specificKey
					}
				},
				usage: {
					findEndpoint: `/findGateways/${blockchainId}`,
					example: `curl http://localhost:${this.node.port - 1000}/findGateways/${blockchainId}`
				}
			});
			
		} catch (error) {
			console.error('Error storing gateway via URL params:', error);
			next(error);
		}
	};

	public debugStorage = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const { key } = req.params;
			
			if (!key) {
				return res.status(400).json({ error: 'Key parameter required' });
			}
			
			// Try to find the value directly
			const numericKey = Number(key);
			const result = await this.node.table.findValue(key);
			
			// Also check with hashed version
			const hashedKey = hashKeyAndmapToKeyspace(key);
			const hashedResult = await this.node.table.findValue(hashedKey.toString());
			
			// Get all stored keys for debugging
			const allPeers = this.node.table.getAllPeers();
			
			return res.json({
				key,
				numericKey,
				hashedKey,
				directResult: result,
				hashedResult,
				resultType: typeof result,
				hashedResultType: typeof hashedResult,
				nodeInfo: {
					nodeId: this.node.nodeId,
					totalPeers: allPeers.length,
					buckets: this.node.table.getAllBucketsLen()
				},
				// Show what we're actually storing locally
				localStorage: (this.node.table as any).store ? 
					Array.from((this.node.table as any).store.entries()).slice(0, 10) : 
					'Storage not accessible'
			});
			
		} catch (error) {
			console.error('Debug storage error:', error);
			next(error);
		}
	};

}

export default BaseController;
