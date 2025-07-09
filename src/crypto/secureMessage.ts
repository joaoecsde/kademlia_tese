import { CryptoManager } from "./keyManager";

export interface SecureMessagePayload {
  encrypted: boolean;
  encryptedData?: string;
  sessionKey?: string;
  signature?: string;
  senderPublicKey?: string;
  plainData?: any;
  iv?: string;
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
      
      // For small messages, use RSA directly
      if (jsonData.length < 200) {
        const encryptedData = this.cryptoManager.encrypt(jsonData, recipientPublicKey);
        const signature = this.cryptoManager.sign(jsonData);
        
        return {
          encrypted: true,
          encryptedData,
          signature,
          senderPublicKey: this.cryptoManager.getPublicKey()
        };
      }
      
      // For larger messages, use hybrid encryption (RSA + AES)
      const sessionKey = this.cryptoManager.generateSessionKey();
      const { encrypted, iv } = this.cryptoManager.encryptWithSessionKey(jsonData, sessionKey);
      const encryptedSessionKey = this.cryptoManager.encrypt(sessionKey, recipientPublicKey);
      const signature = this.cryptoManager.sign(jsonData);
      
      return {
        encrypted: true,
        encryptedData: encrypted,
        sessionKey: encryptedSessionKey,
        signature,
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

      // Verify signature if present
      if (payload.signature && payload.senderPublicKey) {
        const isValid = this.cryptoManager.verify(
          decryptedData,
          payload.signature,
          payload.senderPublicKey
        );
        
        if (!isValid) {
          throw new Error('Message signature verification failed');
        }
      }

      return JSON.parse(decryptedData);
    } catch (error) {
      console.error('Failed to decrypt message:', error);
      throw new Error(`Message decryption failed: ${error.message}`);
    }
  }
}