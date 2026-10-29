import { createContext, useContext } from 'react';

export const ViewCtx = createContext(null);
export const useView = () => useContext(ViewCtx);
