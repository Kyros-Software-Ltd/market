'use client';
// A styled, promise-based replacement for window.prompt().
// const ask = usePrompt();  const name = await ask({ title: 'Name this phone', value: d.name });
import { Button } from '@heroui/react';
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from 'react';
import { TextInput } from './ui';

interface Ask {
    title: string;
    value?: string;
    confirm?: string;
    placeholder?: string;
}
type AskFn = (ask: Ask) => Promise<string | null>;

const Ctx = createContext<AskFn | null>(null);

export function PromptProvider({ children }: { children: ReactNode }) {
    const [open, setOpen] = useState<Ask | null>(null);
    const [value, setValue] = useState('');
    const resolver = useRef<((v: string | null) => void) | null>(null);

    const ask = useCallback<AskFn>(
        (a) =>
            new Promise((resolve) => {
                resolver.current = resolve;
                setValue(a.value ?? '');
                setOpen(a);
            }),
        [],
    );

    function finish(v: string | null) {
        resolver.current?.(v);
        resolver.current = null;
        setOpen(null);
    }

    const submit = () => {
        if (value.trim()) finish(value.trim());
    };

    return (
        <Ctx.Provider value={ask}>
            {children}
            {open && (
                <div
                    className="sheet"
                    style={{ zIndex: 50 }}
                    onMouseDown={(e) => {
                        if (e.target === e.currentTarget) finish(null);
                    }}
                    onKeyDown={(e) => {
                        if (e.key === 'Escape') finish(null);
                    }}
                >
                    <div className="dialog">
                        <h3>{open.title}</h3>
                        <TextInput
                            value={value}
                            onChange={setValue}
                            placeholder={open.placeholder}
                            onEnter={submit}
                            autoFocus
                        />
                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                            <Button variant="ghost" onPress={() => finish(null)}>
                                Cancel
                            </Button>
                            <Button variant="primary" isDisabled={!value.trim()} onPress={submit}>
                                {open.confirm || 'Save'}
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </Ctx.Provider>
    );
}

export function usePrompt() {
    const ask = useContext(Ctx);
    if (!ask) throw new Error('usePrompt outside PromptProvider');
    return ask;
}
