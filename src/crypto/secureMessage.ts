import { CryptoManager } from "./keyManager";

export interface SecureMessagePayload {
  encrypted: boolean;
  encryptedData?: string;
  sessionKey?: string;
  // signature field removed - now encrypted with data
  senderPublicKey?: string;
  plainData?: any;
  iv?: string;
}

// Internal structure for compound payload (encrypted together)
interface CompoundPayload {
  data: any;
  signature?: string;
  timestamp: number; // Add timestamp for replay protection
}

export class SecureMessageHandler {
  constructor(private cryptoManager: CryptoManager) {}

  /**
   * Prepare message for sending
   */
  public prepareMessage(data: any, recipientNodeId: number): SecureMessagePayload {
    const recipientPublicKey = this.cryptoManager.getStoredPublicKey(recipientNodeId);
    
    if (!recipientPublicKey) {
      // Send unencrypted with public key for key exchange
      return {
        encrypted: false,
        plainData: data,
        senderPublicKey: this.cryptoManager.getPublicKey()
      };
    }

    try {
      const jsonData = JSON.stringify(data);
      
      // Create signature for the original data
      const signature = this.cryptoManager.sign(jsonData);
      
      // Create compound payload with data, signature, and timestamp
      const compoundPayload: CompoundPayload = {
        data: data, 
        signature: signature,
        timestamp: Date.now()
      };
      
      const compoundJson = JSON.stringify(compoundPayload);
      
      // For small compound messages, use RSA directly
      if (compoundJson.length < 180) {
        const encryptedCompound = this.cryptoManager.encrypt(compoundJson, recipientPublicKey);
        
        return {
          encrypted: true,
          encryptedData: encryptedCompound,
          senderPublicKey: this.cryptoManager.getPublicKey()
        };
      }
      
      // For larger messages, use hybrid encryption (RSA + AES)
      const sessionKey = this.cryptoManager.generateSessionKey();
      const { encrypted, iv } = this.cryptoManager.encryptWithSessionKey(compoundJson, sessionKey);
      const encryptedSessionKey = this.cryptoManager.encrypt(sessionKey, recipientPublicKey);
      
      return {
        encrypted: true,
        encryptedData: encrypted,
        sessionKey: encryptedSessionKey,
        senderPublicKey: this.cryptoManager.getPublicKey(),
        iv
      };
    } catch (error) {
      console.error('Failed to encrypt message:', error);
      // Fallback to unencrypted
      return {
        encrypted: false,
        plainData: data,
        senderPublicKey: this.cryptoManager.getPublicKey()
      };
    }
  }

  /**
   * Process received message
   */
  public processMessage(payload: SecureMessagePayload, senderNodeId: number): any {
    // Store sender's public key if provided
    if (payload.senderPublicKey) {
      this.cryptoManager.storePublicKey(senderNodeId, payload.senderPublicKey);
    }

    // Return plain data if not encrypted
    if (!payload.encrypted) {
      return payload.plainData;
    }

    try {
      let decryptedData: string;

      if (payload.sessionKey) {
        // Hybrid decryption
        const sessionKey = this.cryptoManager.decrypt(payload.sessionKey);
        decryptedData = this.cryptoManager.decryptWithSessionKey(
          payload.encryptedData!,
          sessionKey,
          payload.iv!
        );
      } else {
        // Direct RSA decryption
        decryptedData = this.cryptoManager.decrypt(payload.encryptedData!);
      }

      // Parse the payload
      const compoundPayload: CompoundPayload = JSON.parse(decryptedData);
      
      // Verify signature if present and we have sender's public key
      if (compoundPayload.signature && payload.senderPublicKey) {
        const originalDataJson = JSON.stringify(compoundPayload.data);
        const isValid = this.cryptoManager.verify(
          originalDataJson,
          compoundPayload.signature,
          payload.senderPublicKey
        );
        
        if (!isValid) {
          throw new Error('Message signature verification failed');
        }
      }

      return compoundPayload.data;
    } catch (error) {
      console.error('Failed to decrypt message:', error);
      throw new Error(`Message decryption failed: ${error.message}`);
    }
  }
}