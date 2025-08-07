import { SecureMessagePayload } from '../crypto/secureMessage';
import { Message } from "../message/message";

export interface Queue<T> {
	[partyId: string]: T | null;
}

export interface MessageQueue<T> {
	[roundNumber: number]: Queue<T>;
}

export type ServerMessage<T extends Message<T>> = {
	message: string;
	type: MessageType;
	transport: Transports;
	data: T;
	senderNode: string;
};

export type UpdMessage<T extends Message<T>> = ServerMessage<T> & {
	resId: string;
};

// biome-ignore lint/complexity/noUselessTypeConstraint: <explanation>
export type TransactionData<T extends any = {}> = {
	type: string;
	data: T;
};

export enum Transports {
	Udp = "UDP",
	Tcp = "TCP",
}

export enum MessageType {
	FoundResponse = "FOUND_RESPONSE",
	Broadcast = "BROADCAST",
	DirectMessage = "DIRECT_MESSAGE",
	PeerDiscovery = "PEER_DISCOVER",
	Handshake = "HANDSHAKE",
	FindNode = "FIND_NODE",
	Reply = "REPLY",
	FindValue = "FIND_VALUE",
	Store = "STORE",
	Ping = "PING",
	Pong = "PONG",
	Close = "CLOSE",
	RegisterGateway = "REGISTER_GATEWAY",
  	FindGateway = "FIND_GATEWAY",
  	GatewayResponse = "GATEWAY_RESPONSE",

	// New secure types
	KeyExchange = "KEY_EXCHANGE",
	KeyDiscovery = "KEY_DISCOVERY",
	KeyResponse = "KEY_RESPONSE",
	SecureHandshake = "SECURE_HANDSHAKE"
}

export enum PacketType {
	Broadcast = "broadcast",
	Direct = "direct",
	HandShake = "handshake",
	Message = "message",
}

export interface KeyExchangeData {
  nodeId: number;
  publicKey: string;
  timestamp: number;
  requestType: 'offer' | 'request' | 'response';
}

export interface SecureUDPDataInfo {
  resId?: string;
  closestNodes?: any[];
  key?: number;
  value?: string;
  blockchainId?: string;
  gateways?: any[];
  // Encryption fields
  encrypted?: boolean;
  securePayload?: SecureMessagePayload;
  // Key exchange fields
  keyExchange?: KeyExchangeData;
}

export interface SecureMessagePayloadWrapper<T = any> {
  originalType: MessageType;
  securePayload: SecureMessagePayload;
  metadata: {
    senderNodeId: number;
    timestamp: number;
    messageId: string;
  };
}

