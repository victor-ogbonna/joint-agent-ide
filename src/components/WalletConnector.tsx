import React, { useState } from "react";
import { Wallet, ShieldCheck, CheckCircle2, ChevronRight, Layers, Lock, Cpu } from "lucide-react";
import { Web3WalletState } from "../types";

interface WalletConnectorProps {
  walletState: Web3WalletState;
  setWalletState: React.Dispatch<React.SetStateAction<Web3WalletState>>;
  onSignMessage: (message: string) => Promise<string | null>;
  blockchainLogs: Array<{ hash: string; txHash: string; timestamp: string; mcu: string }>;
}

export default function WalletConnector({
  walletState,
  setWalletState,
  onSignMessage,
  blockchainLogs
}: WalletConnectorProps) {
  const [error, setError] = useState<string | null>(null);

  const connectWallet = async () => {
    setError(null);
    setWalletState((prev) => ({ ...prev, authenticating: true }));

    const ethereum = (window as any).ethereum;

    if (ethereum) {
      try {
        const accounts = await ethereum.request({ method: "eth_requestAccounts" });
        const chainId = await ethereum.request({ method: "eth_chainId" });
        
        // Mock getting balance (can be implemented properly with ethers.js)
        const balance = "0.052";

        setWalletState({
          connected: true,
          address: accounts[0],
          chainId,
          balance,
          authenticating: false,
          authenticated: true
        });
      } catch (err: any) {
        setError(err.message || "Failed to connect to wallet.");
        setWalletState((prev) => ({ ...prev, authenticating: false }));
      }
    } else {
      // Simulate Sandbox Connection if no real wallet exists (for the agent demo)
      setTimeout(() => {
        setWalletState({
          connected: true,
          address: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
          chainId: "0xaa36a7", // Sepolia
          balance: "1.450",
          authenticating: false,
          authenticated: true
        });
      }, 1000);
    }
  };

  const disconnectWallet = () => {
    setWalletState({
      connected: false,
      address: null,
      chainId: null,
      balance: null,
      authenticating: false,
      authenticated: false
    });
  };

  const getNetworkName = (chainId: string | null) => {
    switch (chainId) {
      case "0x1": return "Ethereum Mainnet";
      case "0xaa36a7": return "Sepolia Testnet";
      case "0x89": return "Polygon Mainnet";
      default: return "Web3 Sandbox / Testnet";
    }
  };

  return (
    <div id="web3-wallet-panel" className="bg-[var(--bg-panel)] flex flex-col w-full h-full">
      {!walletState.connected ? (
        <div className="space-y-4 text-center py-2">
          <div className="flex justify-center mb-2">
            <div className="p-3 bg-blue-500/10 rounded-xl text-blue-400">
               <Wallet size={24} />
            </div>
          </div>
          <p className="text-sm text-[var(--text-muted)] leading-relaxed mb-6">
            Connect a Web3 wallet (MetaMask, WalletConnect, Coinbase) to sign your firmware hashes, verify cryptographic ownership, and log IoT state logs to the ledger.
          </p>
          <div className="space-y-3">
             <button
               onClick={connectWallet}
               disabled={walletState.authenticating}
               className="w-full flex items-center justify-between px-4 py-3 bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] border border-[var(--border-light)] rounded-lg transition group"
             >
               <div className="flex items-center gap-3">
                 <img src="https://upload.wikimedia.org/wikipedia/commons/3/36/MetaMask_Fox.svg" alt="MetaMask" className="w-6 h-6" />
                 <span className="font-semibold text-[var(--text-main)]">MetaMask</span>
               </div>
               <ChevronRight size={16} className="text-[var(--text-muted)] group-hover:text-[var(--text-main)] transition" />
             </button>
             <button
               onClick={connectWallet}
               disabled={walletState.authenticating}
               className="w-full flex items-center justify-between px-4 py-3 bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] border border-[var(--border-light)] rounded-lg transition group"
             >
               <div className="flex items-center gap-3">
                 <div className="w-6 h-6 bg-blue-500 rounded-full flex items-center justify-center text-white font-bold text-[10px]">WC</div>
                 <span className="font-semibold text-[var(--text-main)]">WalletConnect</span>
               </div>
               <ChevronRight size={16} className="text-[var(--text-muted)] group-hover:text-[var(--text-main)] transition" />
             </button>
             <button
               onClick={connectWallet}
               disabled={walletState.authenticating}
               className="w-full flex items-center justify-between px-4 py-3 bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] border border-[var(--border-light)] rounded-lg transition group"
             >
               <div className="flex items-center gap-3">
                 <div className="w-6 h-6 bg-blue-600 rounded-full flex items-center justify-center text-white font-bold text-[10px]">CB</div>
                 <span className="font-semibold text-[var(--text-main)]">Coinbase Wallet</span>
               </div>
               <ChevronRight size={16} className="text-[var(--text-muted)] group-hover:text-[var(--text-main)] transition" />
             </button>
          </div>
          
          {walletState.authenticating && (
             <div className="text-xs text-orange-600 animate-pulse mt-4">Connecting to wallet...</div>
          )}
          {error && <p className="text-[11px] text-red-500 mt-2">{error}</p>}
        </div>
      ) : (
        <div className="space-y-4">
          {/* Wallet Address and Balance */}
          <div className="p-4 bg-[var(--bg-surface)] border border-[var(--border-main)] rounded-lg space-y-3">
            <div className="flex justify-between items-center text-xs">
              <span className="text-[var(--text-muted)]">Gateway Address:</span>
              <span className="font-mono text-orange-600 font-medium">
                {walletState.address ? `${walletState.address.slice(0, 8)}...${walletState.address.slice(-6)}` : ""}
              </span>
            </div>
            <div className="flex justify-between items-center text-xs">
              <span className="text-[var(--text-muted)]">Network:</span>
              <span className="font-medium text-[var(--text-main)]">{getNetworkName(walletState.chainId)}</span>
            </div>
            <div className="flex justify-between items-center text-xs">
              <span className="text-[var(--text-muted)]">Balance:</span>
              <span className="font-mono text-green-500 font-semibold">{walletState.balance} ETH</span>
            </div>
          </div>

          <div className="p-4 bg-orange-500/10 border border-orange-500/20 rounded-lg space-y-2">
            <div className="flex items-center gap-2 text-orange-500 font-semibold text-xs uppercase">
              <Lock size={14} />
              <span>Decentralized Firmware Security</span>
            </div>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed">
              Every flash compiles a cryptographic hash representing the logic state of your microcontroller, which is cryptographically logged to the distributed IoT registry.
            </p>
          </div>

          <div className="space-y-2 pt-2">
            <div className="flex items-center justify-between text-xs font-semibold text-[var(--text-main)]">
              <span className="flex items-center gap-1.5">
                <Layers size={14} /> Recent Immutable Logs ({blockchainLogs.length})
              </span>
            </div>

            {blockchainLogs.length === 0 ? (
              <div className="text-center py-6 border border-dashed border-[var(--border-light)] rounded-lg text-[var(--text-muted)] text-xs">
                No firmware logs published. Compile & Flash to initiate log.
              </div>
            ) : (
              <div className="space-y-2 max-h-32 overflow-y-auto terminal-scrollbar pr-1">
                {blockchainLogs.map((log, idx) => (
                  <div key={idx} className="p-2.5 bg-[var(--bg-surface)] border border-[var(--border-light)] rounded-md text-xs flex items-center justify-between gap-2">
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono font-semibold text-[var(--text-main)]">
                          {log.hash.slice(0, 10)}...
                        </span>
                        <span className="px-1.5 py-0.5 rounded text-[9px] uppercase bg-[#3e3e42] text-[var(--text-muted)] font-medium">
                          {log.mcu}
                        </span>
                      </div>
                      <div className="text-[10px] text-[var(--text-muted)] font-mono truncate">
                        TX: {log.txHash.slice(0, 14)}...
                      </div>
                    </div>
                    <div className="text-right shrink-0 flex flex-col items-end gap-1">
                      <span className="text-[10px] text-[var(--text-muted)] font-mono block">{log.timestamp}</span>
                      <a
                        href={`https://sepolia.etherscan.io/tx/${log.txHash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[10px] font-semibold text-blue-400 hover:text-blue-300 underline"
                      >
                        View TX
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <button
            id="btn-disconnect-wallet"
            onClick={disconnectWallet}
            className="w-full mt-2 text-center text-xs font-semibold text-red-500/80 hover:text-red-500 transition py-2"
          >
            Disconnect Wallet
          </button>
        </div>
      )}
    </div>
  );
}
