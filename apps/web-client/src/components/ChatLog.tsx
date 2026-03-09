import React, { useEffect, useRef } from 'react';
import { Terminal, User, Bot, RefreshCw } from 'lucide-react';

export interface ChatMessage {
    sender: 'user' | 'rachel';
    text: string;
    timestamp: Date;
}

interface ChatLogProps {
    messages: ChatMessage[];
    onRetry?: () => void;
    isThinking?: boolean;
}

export function ChatLog({ messages, onRetry, isThinking }: ChatLogProps) {
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages, isThinking]);

    return (
        <div className="flex flex-col h-full overflow-hidden w-full">
            <div className="flex items-center justify-between px-4 py-3 bg-white/[0.02] border-b border-white/5">
                <div className="flex items-center space-x-2">
                    <Terminal className="w-3.5 h-3.5 text-purple-500/70" />
                    <span className="text-[10px] font-black uppercase tracking-[0.2em] text-neutral-400">Conversational Log</span>
                </div>
                <div className="text-[9px] font-mono text-neutral-600 font-bold opacity-40 select-none">v7.7.0</div>
            </div>

            <div
                ref={scrollRef}
                onWheel={(e) => e.stopPropagation()}
                className="flex-1 overflow-y-auto p-4 space-y-4 scroll-smooth [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
            >
                {messages.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center opacity-20 italic text-sm text-neutral-500">
                        Awaiting transmission...
                    </div>
                ) : (
                    messages.map((msg, idx) => (
                        <div
                            key={idx}
                            className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start'} animate-in fade-in slide-in-from-bottom-2 duration-300 w-full`}
                        >
                            <div className={`flex items-center space-x-2 mb-1.5 opacity-50`}>
                                {msg.sender === 'rachel' ? (
                                    <>
                                        <Bot className="w-3.5 h-3.5 text-purple-400" />
                                        <span className="text-[10px] font-bold uppercase tracking-tighter text-purple-400">Rachel</span>
                                    </>
                                ) : (
                                    <>
                                        <span className="text-[10px] font-bold uppercase tracking-tighter text-blue-400">Pilot</span>
                                        <User className="w-3.5 h-3.5 text-blue-400" />
                                    </>
                                )}
                                <span className="text-[9px] font-mono text-neutral-600">
                                    {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                </span>
                            </div>
                            <div
                                className={`
                  max-w-[95%] px-4 py-3 rounded-xl text-sm leading-relaxed font-medium shadow-lg
                  ${msg.sender === 'rachel'
                                        ? 'bg-purple-500/10 text-purple-100 border border-purple-500/20 rounded-tl-none shadow-[0_0_20px_rgba(168,85,247,0.15)]'
                                        : 'bg-blue-500/10 text-blue-100 border border-blue-500/20 rounded-tr-none shadow-[0_0_20px_rgba(59,130,246,0.15)]'
                                    }
                `}
                            >
                                {msg.text}
                                {msg.text === "The Architect's connection is unstable." && idx === messages.length - 1 && onRetry && (
                                    <button
                                        onClick={onRetry}
                                        className="mt-3 text-xs bg-red-500/20 hover:bg-red-500/40 text-red-200 px-3 py-1.5 rounded border border-red-500/30 transition-colors flex items-center gap-2"
                                    >
                                        <RefreshCw className="w-3 h-3" /> Retry Connection
                                    </button>
                                )}
                            </div>
                        </div>
                    ))
                )}

                {isThinking && (
                    <div className="flex flex-col items-start animate-in fade-in slide-in-from-bottom-2 duration-300 w-full">
                        <div className="flex items-center space-x-2 mb-1.5 opacity-50">
                            <Bot className="w-3.5 h-3.5 text-purple-400" />
                            <span className="text-[10px] font-bold uppercase tracking-tighter text-purple-400">Rachel</span>
                        </div>
                        <div className="bg-purple-500/5 text-purple-400/60 border border-purple-500/10 px-4 py-3 rounded-xl rounded-tl-none flex items-center gap-3">
                            <div className="flex gap-1">
                                <div className="w-1.5 h-1.5 rounded-full bg-purple-500/40 animate-bounce [animation-delay:-0.3s]" />
                                <div className="w-1.5 h-1.5 rounded-full bg-purple-500/40 animate-bounce [animation-delay:-0.15s]" />
                                <div className="w-1.5 h-1.5 rounded-full bg-purple-500/40 animate-bounce" />
                            </div>
                            <span className="text-xs font-mono uppercase tracking-widest animate-pulse">Thinking...</span>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
