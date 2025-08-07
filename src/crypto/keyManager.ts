import crypto from 'crypto';

export interface KeyPair {
    publicKey: string;
    privateKey: string;
}

export interface NodeKeyInfo {
    nodeId: number;
    publicKey: string;
    timestamp: number;
}

export class CryptoManager {
    private keyPair: KeyPair;
    private knownPublicKeys: Map<number, NodeKeyInfo> = new Map();

    constructor() {
    this.generateKeyPair();
    }

    /**
     * Generate RSA key pair for the node
     */
    private generateKeyPair(): void {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: {
        type: 'spki',
        format: 'pem'
        },
        privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem'
        }
    });

    this.keyPair = { publicKey, privateKey };
    }

    /**
     * Get the node's public key
     */
    public getPublicKey(): string {
    return this.keyPair.publicKey;
    }

    /**
     * Get the node's private key 
     */
    private getPrivateKey(): string {
    return this.keyPair.privateKey;
    }

    /**
     * Store a public key for a specific node
     */
    public storePublicKey(nodeId: number, publicKey: string): void {
    this.knownPublicKeys.set(nodeId, {
        nodeId,
        publicKey,
        timestamp: Date.now()
    });
    }

    /**
     * Get stored public key for a node
     */
    public getStoredPublicKey(nodeId: number): string | null {
    const keyInfo = this.knownPublicKeys.get(nodeId);
    return keyInfo ? keyInfo.publicKey : null;
    }

    /**
     * Encrypt data using recipient's public key
     */
    public encrypt(data: string, recipientPublicKey: string): string {
    try {
        const encrypted = crypto.publicEncrypt(
        {
            key: recipientPublicKey,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha256'
        },
        Buffer.from(data, 'utf8')
        );
        return encrypted.toString('base64');
    } catch (error) {
        throw new Error(`Encryption failed: ${error.message}`);
    }
    }

    /**
     * Decrypt data using node's private key
     */
    public decrypt(encryptedData: string): string {
    try {
        const decrypted = crypto.privateDecrypt(
        {
            key: this.getPrivateKey(),
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha256'
        },
        Buffer.from(encryptedData, 'base64')
        );
        return decrypted.toString('utf8');
    } catch (error) {
        throw new Error(`Decryption failed: ${error.message}`);
    }
    }

    /**
     * Sign data with node's private key
     */
    public sign(data: string): string {
    try {
        const signature = crypto.sign('sha256', Buffer.from(data, 'utf8'), {
        key: this.getPrivateKey(),
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        });
        return signature.toString('base64');
    } catch (error) {
        throw new Error(`Signing failed: ${error.message}`);
    }
    }

    /**
     * Verify signature using sender's public key
     */
    public verify(data: string, signature: string, senderPublicKey: string): boolean {
    try {
        return crypto.verify(
        'sha256',
        Buffer.from(data, 'utf8'),
        {
            key: senderPublicKey,
            padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        },
        Buffer.from(signature, 'base64')
        );
    } catch (error) {
        console.error(`Signature verification failed: ${error.message}`);
        return false;
    }
    }

    /**
     * Generate session key for symmetric encryption (AES)
     */
    public generateSessionKey(): string {
    return crypto.randomBytes(32).toString('base64');
    }

    /**
     * Encrypt large data using AES with session key (SECURE VERSION)
     */
    public encryptWithSessionKey(data: string, sessionKey: string): {
    encrypted: string;
    iv: string;
    } {
    try {
        const key = Buffer.from(sessionKey, 'base64');
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        
        let encrypted = cipher.update(data, 'utf8', 'base64');
        encrypted += cipher.final('base64');
        
        return {
            encrypted,
            iv: iv.toString('base64')
        };
    } catch (error) {
        throw new Error(`Session encryption failed: ${error.message}`);
    }
    }

    /**
     * Decrypt large data using AES with session key (SECURE VERSION)
     */
    public decryptWithSessionKey(encryptedData: string, sessionKey: string, iv: string): string {
    try {
        const key = Buffer.from(sessionKey, 'base64');
        const ivBuffer = Buffer.from(iv, 'base64');
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, ivBuffer);
        
        let decrypted = decipher.update(encryptedData, 'base64', 'utf8');
        decrypted += decipher.final('utf8');
        
        return decrypted;
    } catch (error) {
        throw new Error(`Session decryption failed: ${error.message}`);
    }
    }

    /**
     * Get all known public keys
     */
    public getAllKnownKeys(): NodeKeyInfo[] {
    return Array.from(this.knownPublicKeys.values());
    }

    /**
     * Clean up old keys (older than 24 hours)
     */
    public cleanupOldKeys(): void {
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    const now = Date.now();

    for (const [nodeId, keyInfo] of this.knownPublicKeys.entries()) {
        if (now - keyInfo.timestamp > maxAge) {
        this.knownPublicKeys.delete(nodeId);
        }
    }
    }

    /**
     * Export key pair for backup
     */
    public exportKeyPair(): KeyPair {
    return { ...this.keyPair };
    }

    /**
     * Import key pair from backup
     */
    public importKeyPair(keyPair: KeyPair): void {
    this.keyPair = { ...keyPair };
    }
}