import { ReactNode, createContext, useContext, useState } from 'react'

type ContextProps = {
  game: Game | null
  setGame: (game: Game | null) => void
}

const GameContext = createContext<ContextProps>({
  game: null,
  setGame: (game: Game | null) => {},
})

export const useGame = () => {
  const gameContext = useContext(GameContext)

  if (!gameContext)
    throw new Error('useGame must be used within an GameContextProvider')

  return gameContext
}

type ProviderProps = {
  children: ReactNode
}

export const GameProvider = ({ children }: ProviderProps) => {
  const [game, setGame] = useState<Game | null>(null)

  const gameValue = { game, setGame }

  return (
    <GameContext.Provider value={gameValue}>{children}</GameContext.Provider>
  )
}
