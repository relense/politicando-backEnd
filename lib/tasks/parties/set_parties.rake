namespace :parties do
  task set_parties: :environment do
    parties = [
      {
        name: "PS",
        description: "Partido Socialista"
      },
      {
        name: "PSD",
        description: "Partido Socialista Democrata"
      },
      {
        name: "BE",
        description: "Bloco de Esquerda"
      },
      {
        name: "CDS-PP",
        description: "CDS – Partido Popular"
      },
      {
        name: "PCP",
        description: "Partido Comunista Português"
      },
      {
        name: "PEV",
        description: "Partido Ecologista \"Os Verdes\""
      },
      {
        name: "PAN",
        description: "Pessoas-Animais-Natureza"
      }
    ]
     
    parties.each do |party|
      Partido.create(party_name: party[:name], description: party[:description])
    end
  end
end