# Kademlia DHT Gateway System

A distributed hash table implementation using the Kademlia protocol with enhanced gateway functionality for blockchain interoperability.

## Security Features

This implementation includes **hybrid encryption** with:
- **RSA key pair generation** for each node
- **Automatic key discovery** and exchange
- **Hybrid encryption** (RSA + AES) for large messages
- **Digital signatures** for message integrity
- **Secure DHT operations** with encrypted storage/retrieval
- **Secure gateway operations** with encrypted discovery

## Usage

To use this and run the keygen process yourself, first clone the repo and run:
```bash
pnpm install
```

Then in order to start the service export a default env for the bootstrap node 3000 (fake bootstrap) or an easier way is to open up a bash terminal and run the following commands to set up env vars (it's recommended to run the dev script when testing or just trying out the service):

```bash
export NODE_ENV=development PORT=3000
nvm use 18.20.0
pnpm start // for single node (prod script)

// or

pnpm run start:dev // to run 32 nodes concurrently (dev script)
```

You can then observe the peer discovery process and begin to interact with each node's HTTP API for getting node information and sending messages.

## Port Configuration

**Important**: The HTTP server is always deployed at `port 2000 + nodeId`

| Node ID | UDP Port | HTTP Port |
|---------|----------|-----------|
| 1       | 3001     | 2001      |
| 2       | 3002     | 2002      |
| 3       | 3003     | 2003      |
| 4       | 3004     | 2004      |
| 5       | 3005     | 2005      |

For all available HTTP methods, see `src/http/controller/basecontroller.ts`

## API Endpoints

### Basic Node Operations

**Health Check**
```bash
GET http://localhost:2001/ping
```

**Get Node Buckets**
Returns a node's buckets and all peers stored in each
```bash
GET http://localhost:2001/getBucketNodes
```

**Get All Peers**
Returns all known peers
```bash
GET http://localhost:2001/getPeers
```

### DHT Operations

**Store Value**
Stores a value on a given node
```bash
GET http://localhost:2001/store/value
```

**Find Value**
Returns a previously stored value in the DHT
```bash
GET http://localhost:2001/findValue/value
```

**Find Closest Node**
Finds the closest node to a given ID
```bash
GET http://localhost:2001/findClosestNode/id
```

**Debug Closest Nodes**
To know where your value will be stored
```bash
GET http://localhost:2001/debugClosestNodes/value
```

**Debug Storage**
Debug storage for specific key
```bash
GET http://localhost:2001/debugStorage/key
```

### Gateway Operations

#### Standard Gateway Registration

**Store Gateway (POST Method)**
```bash
curl -X POST http://localhost:2001/storeGateway \
  -H "Content-Type: application/json" \
  -d '{
    "blockchainId": "hardhat1",
    "endpoint": "http://localhost:8545",
    "supportedProtocols": ["SATP", "ILP"]
  }'
```

**Store Gateway (GET Method - Simple)**
```bash
GET http://localhost:2001/storeGateway/hardhat1/http%3A%2F%2Flocalhost%3A8545

# With custom protocols
GET http://localhost:2001/storeGateway/hardhat1/http%3A%2F%2Flocalhost%3A8545?protocols=SATP,ILP
```

#### Gateway Discovery

**Find Gateways**
```bash
GET http://localhost:2002/findGateway/hardhat1

# Include unhealthy gateways
GET http://localhost:2002/findGateway/hardhat1?includeUnhealthy=true

# Filter by age (only gateways less than 30 minutes old)
GET http://localhost:2002/findGateway/hardhat1?maxAge=30

# Combine filters
GET http://localhost:2002/findGateway/hardhat1?includeUnhealthy=false&maxAge=60
```

#### Gateway Management

**List All Gateways**
```bash
GET http://localhost:2001/gateways
```

**Gateway Health Check**
```bash
GET http://localhost:2001/gateway/hardhat1/health
```

## Security Operations

### Crypto Management

**Get Public Key**
Returns the node's public key and fingerprint
```bash
GET http://localhost:2001/crypto/publickey
```

**Get Known Keys**
Returns all known public keys from other nodes
```bash
GET http://localhost:2001/crypto/keys
```

**Get Crypto Statistics**
Returns encryption status and key statistics
```bash
GET http://localhost:2001/crypto/stats
```

**Enable/Disable Encryption**
Toggle encryption on/off (on by default)
```bash
# Enable encryption
GET http://localhost:2001/crypto/encryption/true

# Disable encryption
GET http://localhost:2001/crypto/encryption/false
```

**Trigger Key Discovery**
Initiates key discovery with all known peers
```bash
curl -X POST http://localhost:2001/crypto/discover
```

**Trigger Key Exchange**
Forces key exchange with all peers
```bash
GET http://localhost:2001/crypto/exchange-keys
```

**Network Crypto Status**
Shows encryption status across the network
```bash
GET http://localhost:2001/crypto/network-status
```

### Secure DHT Operations

**Secure Store**
Stores a value with encryption
```bash
GET http://localhost:2001/secure/store/mySecretData
```

**Secure Ping**
Encrypted ping to another node
```bash
GET http://localhost:2001/secure/ping/2/3002
```

#### Secure Gateway Operations

**Secure Gateway Store (POST Method)**
```bash
curl -X POST http://localhost:2001/secure/storeGateway \
  -H "Content-Type: application/json" \
  -d '{
    "blockchainId": "hardhat1",
    "endpoint": "http://localhost:8545",
    "supportedProtocols": ["SATP", "ILP"]
  }'
```

**Secure Gateway Store (GET Method)**
```bash
GET http://localhost:2001/secure/storeGateway/hardhat1/http%3A%2F%2Flocalhost%3A8545

# With custom protocols
GET http://localhost:2001/secure/storeGateway/hardhat1/http%3A%2F%2Flocalhost%3A8545?protocols=SATP,ILP
```

**Find Gateways (Secure)**
```bash
GET http://localhost:2002/secure/findGateway/hardhat1

# Include unhealthy gateways (secure)
GET http://localhost:2002/secure/findGateway/hardhat1?includeUnhealthy=true

# Filter by age (secure)
GET http://localhost:2002/secure/findGateway/hardhat1?maxAge=30

# Combine filters (secure)
GET http://localhost:2002/secure/findGateway/hardhat1?includeUnhealthy=false&maxAge=60
```

**List All Gateways (Secure)**
```bash
GET http://localhost:2001/secure/gateways
```

**Gateway Health Check (Secure)**
```bash
GET http://localhost:2001/secure/gateway/hardhat1/health
```


## Common Usage Examples

### Quick Gateway Test

```bash
# 1. Store a gateway on node 1
curl -X POST http://localhost:2001/storeGateway \
  -H "Content-Type: application/json" \
  -d '{"blockchainId": "hardhat1", "endpoint": "http://localhost:8545"}'

# 2. Find gateway from node 2 (tests DHT distribution)
curl "http://localhost:2002/findGateway/hardhat1?includeUnhealthy=true"

# 3. Check gateway health
curl "http://localhost:2001/gateway/hardhat1/health"

# 4. List all gateways on node 1
curl "http://localhost:2001/gateways"
```

### Secure Gateway Workflow

```bash
# 1. Check encryption status
curl "http://localhost:2001/crypto/stats"

# 2. Trigger key exchange (if needed)
curl -X POST "http://localhost:2001/crypto/discover"

# 3. Store gateway securely
curl -X POST http://localhost:2001/secure/storeGateway \
  -H "Content-Type: application/json" \
  -d '{"blockchainId": "hardhat1", "endpoint": "http://localhost:8545"}'

# 4. Find gateway securely from another node
curl "http://localhost:2002/secure/findGateway/hardhat1"

# 5. Check secure gateway health
curl "http://localhost:2001/secure/gateway/hardhat1/health"

# 6. List all secure gateways
curl "http://localhost:2001/secure/gateways"
```

### Multiple Blockchain Gateways

```bash
# Store different blockchain gateways
curl -X POST http://localhost:2001/storeGateway -H "Content-Type: application/json" \
  -d '{"blockchainId": "ethereum", "endpoint": "https://mainnet.infura.io/v3/your-key"}'

curl -X POST http://localhost:2002/storeGateway -H "Content-Type: application/json" \
  -d '{"blockchainId": "polygon", "endpoint": "https://polygon-rpc.com"}'

curl -X POST http://localhost:2003/storeGateway -H "Content-Type: application/json" \
  -d '{"blockchainId": "avalanche", "endpoint": "https://api.avax.network/ext/bc/C/rpc"}'

# Find any gateway from any node
curl "http://localhost:2001/findGateway/ethereum"
curl "http://localhost:2004/findGateway/polygon"
curl "http://localhost:2005/findGateway/avalanche"
```

### Secure Network Setup

```bash
# 1. Check network crypto status
curl "http://localhost:2001/crypto/network-status"

# 2. Enable encryption on all nodes (by default they are true)
curl "http://localhost:2001/crypto/encryption/true"
curl "http://localhost:2002/crypto/encryption/true"
curl "http://localhost:2003/crypto/encryption/true"

# 3. Trigger key exchange on all nodes
curl -X POST "http://localhost:2001/crypto/discover"
curl -X POST "http://localhost:2002/crypto/discover"
curl -X POST "http://localhost:2003/crypto/discover"

# 4. Verify encryption coverage
curl "http://localhost:2001/crypto/network-status"

# 5. Test secure operations
curl "http://localhost:2001/secure/store/mySecretData"
curl "http://localhost:2002/findValue/mySecretData"
curl "http://localhost:2001/secure/ping/2/3002"
```

## Testing

### Run All Tests
```bash
npx jest --config jest.config.js src/test/
```

### Run Specific Test Suites

**Basic DHT Operations**
```bash
npx jest --config jest.config.js src/test/dht-basic-operation.test.ts
```

**Secure DHT Operations**
```bash
npx jest --config jest.config.js src/test/dht-basic-operation-encrypted.test.ts
```

**HTTP API Tests**
```bash
npx jest --config jest.config.js src/test/http-api-dht.test.ts
```

**Secure HTTP API Tests**
```bash
npx jest --config jest.config.js src/test/secure-http-api.test.ts
```

### Test Setup Requirements

For the gateway tests you will need to start a hardhat gateway, to do this:
```bash
cd EVM && npx hardhat node --hostname 0.0.0.0 --port 8545
```

**Gateway HTTP API Tests**
```bash
npx jest --config jest.config.js src/test/gateway-http-dht.test.ts
```

**Secure Gateway HTTP API Tests**
```bash
npx jest --config jest.config.js src/test/secure-gateway-http-dht.test.ts
```

### Test Categories

#### Standard Test Suite
- **dht-basic-operation.test.ts**: Basic DHT store/find operations
- **http-api-dht.test.ts**: HTTP API for DHT operations
- **gateway-http-dht.test.ts**: Gateway registration and discovery via HTTP

#### Secure Test Suite
- **dht-basic-operation-encrypted.test.ts**: Encrypted DHT operations
- **http-api-secure.test.ts**: Secure HTTP API operations
- **gateway-http-secure.test.ts**: Secure gateway operations via HTTP

## Security Architecture

### Key Management
- **Automatic RSA key pair generation** on node startup
- **Public key distribution** via DHT
- **Key discovery and exchange** with all network peers
- **Periodic key cleanup** and refresh

### Encryption Methods
- **RSA encryption** for small messages (< 200 bytes)
- **Hybrid RSA+AES encryption** for larger messages
- **Digital signatures** for message integrity
- **Secure message wrapping** with metadata

### Security Features
- **End-to-end encryption** for all secure operations
- **Automatic key exchange** during peer discovery
- **Graceful fallback** to unencrypted when keys unavailable
- **Encryption status monitoring** and network coverage analysis

## Development

### Project Structure
```
src/
├── crypto/              # Encryption and key management
│   ├── keyManager.ts    # RSA key generation and management
│   ├── keyDiscovery.ts  # Automated key discovery
│   └── secureMessage.ts # Message encryption/decryption
├── gateway/             # Gateway information management
├── http/                # HTTP API layer
└── node/                # Core Kademlia implementation
```

### Key Components
- **KademliaNode**: Core DHT implementation with encryption
- **CryptoManager**: RSA key management and encryption
- **SecureMessageHandler**: Message encryption/decryption
- **KeyDiscoveryManager**: Automated key exchange
- **GatewayInfo**: Blockchain gateway management

## Monitoring

### Network Status
```bash
# Check overall network health
curl "http://localhost:2001/crypto/network-status"

# Check individual node crypto stats
curl "http://localhost:2001/crypto/stats"

# View known keys
curl "http://localhost:2001/crypto/keys"

# View all peers
curl "http://localhost:2001/getPeers"
```

### Debug Information
```bash
# Debug key distribution
curl "http://localhost:2001/debugClosestNodes/myValue"

# Debug storage
curl "http://localhost:2001/debugStorage/myKey"
```

## Advanced Features

### Automatic Key Exchange
The system automatically exchanges public keys during:
- **Node bootstrap** process
- **Peer discovery** operations
- **First communication** with unknown nodes
- **Periodic maintenance** cycles

### Hybrid Encryption
- **Small messages** (< 200 bytes): Direct RSA encryption
- **Large messages** (≥ 200 bytes): RSA + AES hybrid encryption
- **Session keys**: Generated for each large message
- **Digital signatures**: Applied to all encrypted messages

### Network Resilience
- **Graceful degradation** when encryption fails
- **Automatic fallback** to unencrypted operations
- **Key recovery** mechanisms
- **Network partition** handling

## Troubleshooting

### Common Issues

**Keys Not Exchanging**
```bash
# Force key discovery
curl -X POST "http://localhost:2001/crypto/discover"

# Check network crypto status
curl "http://localhost:2001/crypto/network-status"
```

**Encryption Not Working**
```bash
# Check if encryption is enabled
curl "http://localhost:2001/crypto/stats"

# Enable encryption
curl "http://localhost:2001/crypto/encryption/true"
```

**Gateway Not Found**
```bash
# Check if gateway was stored
curl "http://localhost:2001/debugStorage/hardhat1"

# Try both secure and standard find
curl "http://localhost:2002/findGateway/hardhat1"
curl "http://localhost:2002/secure/findGateway/hardhat1"
```

### Debug Commands
```bash
# View node buckets
curl "http://localhost:2001/getBucketNodes"

# View all known peers
curl "http://localhost:2001/getPeers"

# Check crypto statistics
curl "http://localhost:2001/crypto/stats"

# View network encryption status
curl "http://localhost:2001/crypto/network-status"
```