import { createCipheriv, randomBytes, scryptSync } from "crypto";
import { createReadStream, createWriteStream } from "fs";

export function encryptFile(inputPath, outputPath, password){
    const salt = randomBytes(16);
    const key = scryptSync(password, salt, 32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const input = createReadStream(inputPath);
    const output = createWriteStream(outputPath);
    output.write(salt);
    output.write(iv);
    input.pipe(cipher).pipe(output);
    cipher.on("end", () => {
        output.write(cipher.getAuthTag());
        return {success: true, result: outputPath}
    });
}

export function decryptFile(inputPath, outputPath, password){
    const input = createReadStream(inputPath);
    let header = Buffer.alloc(0);

    input.on("data", (chunk) => {
      header = Buffer.concat([header, chunk]);
      if (header.length >= 16 + 12 + 16) {
        input.pause();
        
        const salt = header.slice(0, 16);
        const iv = header.slice(16, 28);
        const tag = header.slice(28, 44);
        
        const key = scryptSync(password, salt, 32);
        
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        
        const output = createWriteStream(outputPath);
        
        const encryptedData = header.slice(44);
        decipher.write(encryptedData);
        
        input.pipe(decipher).pipe(output);
        
        input.resume();
      }
    });
  
    input.on("end", () => console.log("Fichier déchiffré :", outputPath));
}