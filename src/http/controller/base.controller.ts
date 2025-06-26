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
		return res.json({ message: "success" });
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
				message: `received direct message from node ${this.node.port}`,
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
				message: `received broadcast message from node ${this.node.port}`,
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

	public findGateways = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const { blockchainId } = req.params;
			const { includeUnhealthy = 'false', maxAge } = req.query;
			
			if (!blockchainId) {
				return res.status(400).json({ 
					error: 'blockchainId is required' 
				});
			}
			
			console.log(`API: Finding gateways for ${blockchainId}`);
			const allGateways = await this.node.findGateways(blockchainId);
			
			// Filter gateways based on query parameters
			let filteredGateways = allGateways;
			
			// Filter by age if specified
			if (maxAge) {
				const maxAgeMs = parseInt(maxAge as string) * 60 * 1000; // Convert minutes to ms
				filteredGateways = filteredGateways.filter(gw => 
					Date.now() - gw.timestamp <= maxAgeMs
				);
			}
			
			// Filter by health status
			if (includeUnhealthy === 'false') {
				filteredGateways = filteredGateways.filter(gw => {
					// Include gateways that are healthy OR have unknown health status
					// Only exclude if explicitly marked as unhealthy
					return gw.isHealthy !== false;
				});
			}
			
			// Enhance gateway info with computed fields
			const enhancedGateways = filteredGateways.map(gw => {
				const gateway = gw instanceof GatewayInfo ? gw : GatewayInfo.deserialize(JSON.stringify(gw));
				return gateway.toSummary();
			});
			
			return res.json({
				blockchainId,
				gateways: enhancedGateways,
				count: enhancedGateways.length,
				totalFound: allGateways.length,
				filtered: allGateways.length - enhancedGateways.length,
				searchedFrom: {
					nodeId: this.node.nodeId,
					httpPort: 2000 + this.node.nodeId, // Fixed: HTTP port is 2000 + nodeId
					udpPort: this.node.port
				},
				filters: {
					includeUnhealthy: includeUnhealthy === 'true',
					maxAge: maxAge ? `${maxAge} minutes` : 'none'
				},
				message: enhancedGateways.length > 0 
					? `Found ${enhancedGateways.length} gateway(s) for ${blockchainId}`
					: `No gateways found for ${blockchainId}`,
				timestamp: Date.now()
			});
		} catch (error) {
			console.error('Error finding gateways:', error);
			next(error);
		}
	};

	
	public storeGateway = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const { blockchainId, endpoint, supportedProtocols = ['SATP'], performHealthCheck = true } = req.body;
			
			// Enhanced validation
			if (!blockchainId || !endpoint) {
				return res.status(400).json({
					success: false,
					error: 'Missing required fields: blockchainId and endpoint are required',
					received: { blockchainId, endpoint, supportedProtocols }
				});
			}

			console.log(`API: Storing gateway ${blockchainId} -> ${endpoint}`);

			// Create and validate gateway info
			let gatewayInfo: GatewayInfo;
			try {
				gatewayInfo = new GatewayInfo(
					blockchainId,
					this.node.nodeId,
					endpoint,
					Array.isArray(supportedProtocols) ? supportedProtocols : [supportedProtocols]
				);
			} catch (validationError) {
				return res.status(400).json({
					success: false,
					error: `Gateway validation failed: ${validationError.message}`,
					details: { blockchainId, endpoint, supportedProtocols }
				});
			}

			// Optional health check
			if (performHealthCheck) {
				try {
					console.log(`Performing health check for ${endpoint}`);
					const healthResult = await this.performGatewayHealthCheck(endpoint);
					gatewayInfo.updateHealth(healthResult.healthy, healthResult.chainId);
					
					if (!healthResult.healthy) {
						console.warn(`Health check failed for ${endpoint}: ${healthResult.error}`);
					}
				} catch (healthError) {
					console.warn(`Health check error for ${endpoint}:`, healthError.message);
					gatewayInfo.updateHealth(false);
				}
			}
			
			// Generate storage keys
			const gatewayKey = hashKeyAndmapToKeyspace(`gw-${blockchainId}`);
			const specificKey = hashKeyAndmapToKeyspace(`gw-${blockchainId}-${this.node.nodeId}`);
			
			console.log(`Storing with keys: Primary=${gatewayKey}, Specific=${specificKey}`);
			
			// Store using both keys
			const results = await Promise.allSettled([
				this.node.store(gatewayKey, gatewayInfo.serialize()),
				this.node.store(specificKey, gatewayInfo.serialize())
			]);
			
			const successful = results.filter(r => r.status === 'fulfilled').length;
			const failed = results.filter(r => r.status === 'rejected').length;
			
			// Enhanced response
			return res.json({
				success: true,
				message: `Gateway for ${blockchainId} stored successfully on ${successful} key(s)`,
				gateway: gatewayInfo.toSummary(),
				storage: {
					successful,
					failed,
					keys: {
						primary: gatewayKey,
						specific: specificKey
					}
				},
				nodeInfo: {
					kademliaNodeId: this.node.nodeId,
					httpPort: 2000 + this.node.nodeId, // Fixed: HTTP port is 2000 + nodeId
					udpPort: this.node.port
				},
				nextSteps: {
					findEndpoint: `/findGateway/${blockchainId}`,
					curlExample: `curl http://localhost:${2000 + this.node.nodeId}/findGateway/${blockchainId}`
				}
			});
			
		} catch (error) {
			console.error('Error storing gateway:', error);
			return res.status(500).json({
				success: false,
				error: 'Internal server error during gateway storage',
				details: error.message
			});
		}
	};

	
	public storeGatewaySimple = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const { blockchainId, endpoint } = req.params;
			const { protocols, healthCheck = 'true' } = req.query;
			
			
			let supportedProtocols = ['SATP']; // default
			if (protocols) {
				supportedProtocols = typeof protocols === 'string' 
					? protocols.split(',').map(p => p.trim()).filter(p => p.length > 0)
					: Array.isArray(protocols) 
						? protocols.map(p => String(p).trim()).filter(p => p.length > 0)
						: ['SATP'];
			}
			
			const decodedEndpoint = decodeURIComponent(endpoint);
			console.log(`API: Storing gateway via GET ${blockchainId} -> ${decodedEndpoint}`);
			
			// Create and validate gateway info
			let gatewayInfo: GatewayInfo;
			try {
				gatewayInfo = new GatewayInfo(
					blockchainId,
					this.node.nodeId, 
					decodedEndpoint,
					supportedProtocols
				);
			} catch (validationError) {
				return res.status(400).json({
					success: false,
					error: `Gateway validation failed: ${validationError.message}`,
					originalEndpoint: endpoint,
					decodedEndpoint,
					example: 'Use: /storeGateway/hardhat1/http%3A%2F%2Flocalhost%3A8545'
				});
			}

			// Optional health check
			if (healthCheck === 'true') {
				try {
					const healthResult = await this.performGatewayHealthCheck(decodedEndpoint);
					gatewayInfo.updateHealth(healthResult.healthy, healthResult.chainId);
				} catch (healthError) {
					console.warn(`Health check error for ${decodedEndpoint}:`, healthError.message);
					gatewayInfo.updateHealth(false);
				}
			}
			
			const gatewayKey = hashKeyAndmapToKeyspace(`gw-${blockchainId}`);
			const specificKey = hashKeyAndmapToKeyspace(`gw-${blockchainId}-${this.node.nodeId}`);
			
			const results = await Promise.allSettled([
				this.node.store(gatewayKey, gatewayInfo.serialize()),
				this.node.store(specificKey, gatewayInfo.serialize())
			]);
			
			const successful = results.filter(r => r.status === 'fulfilled').length;
			const failed = results.filter(r => r.status === 'rejected').length;
			
			return res.json({
				success: true,
				message: `Gateway for ${blockchainId} stored successfully`,
				gateway: gatewayInfo.toSummary(),
				storage: {
					successful,
					failed,
					keys: {
						primary: gatewayKey,
						specific: specificKey
					}
				},
				nodeInfo: {
					kademliaNodeId: this.node.nodeId,
					httpPort: 2000 + this.node.nodeId,
					udpPort: this.node.port,
				},
				nextSteps: {
					findEndpoint: `/findGateway/${blockchainId}`,
					curlExample: `curl http://localhost:${2000 + this.node.nodeId}/findGateway/${blockchainId}`
				}
			});
			
		} catch (error) {
			console.error('Error storing gateway via URL params:', error);
			return res.status(500).json({
				success: false,
				error: 'Internal server error during gateway storage',
				details: error.message
			});
		}
	};

	public listGateways = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const registeredGateways = this.node.getRegisteredGateways();
			const gatewayArray = Array.from(registeredGateways.entries()).map(([blockchainId, gateway]) => {
				const gw = gateway instanceof GatewayInfo ? gateway : GatewayInfo.deserialize(JSON.stringify(gateway));
				return gw.toSummary();
			});
			
			return res.json({
				nodeId: this.node.nodeId,
				totalGateways: gatewayArray.length,
				gateways: gatewayArray,
				message: `Node ${this.node.nodeId} has ${gatewayArray.length} registered gateway(s)`,
				timestamp: Date.now()
			});
		} catch (error) {
			next(error);
		}
	};

	public checkGatewayHealth = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const { blockchainId } = req.params;
			const gateways = await this.node.findGateways(blockchainId);
			
			if (gateways.length === 0) {
				return res.json({
					blockchainId,
					status: 'not_found',
					totalGateways: 0,
					healthyGateways: 0,
					gateways: [],
					message: `No gateways found for ${blockchainId}`
				});
			}
			
			console.log(`Performing health checks for ${gateways.length} ${blockchainId} gateways`);
			
			// Check health of each gateway
			const healthChecks = await Promise.allSettled(
				gateways.map(async (gateway) => {
					const healthResult = await this.performGatewayHealthCheck(gateway.endpoint);
					return {
						...gateway,
						...healthResult,
						age: Date.now() - gateway.timestamp
					};
				})
			);
			
			const healthResults = healthChecks.map(result => 
				result.status === 'fulfilled' ? result.value : {
					healthy: false,
					error: 'Health check failed'
				}
			);
			
			const healthyCount = healthResults.filter(r => r.healthy).length;
			
			return res.json({
				blockchainId,
				totalGateways: gateways.length,
				healthyGateways: healthyCount,
				status: healthyCount > 0 ? 'healthy' : 'unhealthy',
				gateways: healthResults,
				message: `${healthyCount}/${gateways.length} gateways healthy for ${blockchainId}`,
				timestamp: Date.now()
			});
		} catch (error) {
			next(error);
		}
	};

	// Helper method to perform gateway health checks
	private async performGatewayHealthCheck(endpoint: string): Promise<{
		healthy: boolean;
		chainId?: number;
		responseTime?: number;
		error?: string;
	}> {
		const startTime = Date.now();
		
		try {
			
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
			
			const response = await fetch(endpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					method: 'eth_chainId',
					params: [],
					id: 1
				}),
				signal: controller.signal
			});
			
			clearTimeout(timeoutId);
			
			if (!response.ok) {
				return {
					healthy: false,
					responseTime: Date.now() - startTime,
					error: `HTTP ${response.status}: ${response.statusText}`
				};
			}
			
			const data = await response.json();
			const responseTime = Date.now() - startTime;
			
			if (data.result) {
				return {
					healthy: true,
					chainId: parseInt(data.result, 16),
					responseTime
				};
			} else {
				return {
					healthy: false,
					responseTime,
					error: data.error?.message || 'No result in response'
				};
			}
		} catch (error) {
			return {
				healthy: false,
				responseTime: Date.now() - startTime,
				error: error.message
			};
		}
	}

	public debugStorage = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const { key } = req.params;
			
			if (!key) {
				return res.status(400).json({ error: 'Key parameter required' });
			}
			
			// Try multiple key formats
			const numericKey = Number(key);
			const directResult = await this.node.table.findValue(key);
			const hashedKey = hashKeyAndmapToKeyspace(key);
			const hashedResult = await this.node.table.findValue(hashedKey.toString());
			
			// Try gateway-specific formats
			const gatewayKey = hashKeyAndmapToKeyspace(`gw-${key}`);
			const gatewayResult = await this.node.table.findValue(gatewayKey.toString());
			
			const allPeers = this.node.table.getAllPeers();
			
			return res.json({
				query: {
					originalKey: key,
					numericKey,
					hashedKey,
					gatewayKey
				},
				results: {
					direct: {
						found: directResult !== undefined,
						type: typeof directResult,
						value: typeof directResult === 'string' ? directResult.substring(0, 200) : directResult
					},
					hashed: {
						found: hashedResult !== undefined,
						type: typeof hashedResult,
						value: typeof hashedResult === 'string' ? hashedResult.substring(0, 200) : hashedResult
					},
					gateway: {
						found: gatewayResult !== undefined,
						type: typeof gatewayResult,
						value: typeof gatewayResult === 'string' ? gatewayResult.substring(0, 200) : gatewayResult
					}
				},
				nodeInfo: {
					nodeId: this.node.nodeId,
					totalPeers: allPeers.length,
					buckets: this.node.table.getAllBucketsLen(),
					httpPort: 2000 + this.node.nodeId, 
					udpPort: this.node.port
				},
				localStorage: (this.node.table as any).store ? 
					Array.from((this.node.table as any).store.entries()).slice(0, 10).map(([k, v]) => ({
						key: k,
						valueType: typeof v,
						valuePreview: typeof v === 'string' ? v.substring(0, 100) : String(v)
					})) : 
					'Storage not accessible'
			});
			
		} catch (error) {
			console.error('Debug storage error:', error);
			next(error);
		}
	};
}

export default BaseController;