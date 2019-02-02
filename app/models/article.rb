class Article < ApplicationRecord
  has_and_belongs_to_many :partidos
  has_many :comments

  def associate_party_include
    parties = Partido.all

    associated = false

    parties.each do |party|
      if title.include?(" #{party.party_name} ") || title.include?(" #{party.description} ")
        ArticlesPartido.create(partido_id: party.id, article_id: self.id)
        return true
      end

      if content.include?(" #{party.party_name} ") || content.include?(" #{party.description} ")
        ArticlesPartido.create(partido_id: party.id, article_id: self.id)
        return true
      end
    end

    associated
  end

  def associate_party
    parties = Partido.all #ir buscar todos os partidos
    associated_parties = ""
    associated = false #variavel que vai permitir saber se o artigo foi associado.
    party_count = Array.new(14) { 0 } #array para guardar a contagem de cada partido

    parties.each_with_index do |party, index|

      if party.description === "LIVRE" 
        party_count[index] = title.scan(/\s#{party.description}\W/).length #space in the beggining and end of word
        party_count[index] += title.scan(/^#{party.description}\s/).length #beggining of the line word with space after

        party_count[index] += content.scan(/\s#{party.description}\W/).length
        party_count[index] += content.scan(/^#{party.description}\s/).length

      elsif party.party_name === "MAS"
        party_count[index] = title.scan(/\s#{"Partido " + party.party_name}\W/).length #space in the beggining and end of word
        party_count[index] += title.scan(/^#{"Partido " + party.party_name}\s/).length #beggining of the line word with space after

        party_count[index] += title.scan(/\s#{party.description}\W/).length
        party_count[index] += title.scan(/^#{party.description}\s/).length

        party_count[index] += content.scan(/\s#{"Partido " + party.party_name}\W/).length
        party_count[index] += content.scan(/^#{"Partido " + party.party_name}\s/).length

        party_count[index] += content.scan(/\s#{party.description}\W/).length
        party_count[index] += content.scan(/^#{party.description}\s/).length

      elsif party.description === "Iniciativa Liberal"
        party_count[index] = title.scan(/\s#{party.party_name}\W/).length #space in the beggining and end of word
        party_count[index] += title.scan(/^#{party.party_name}\s/).length #beggining of the line word with space after

        party_count[index] += title.scan(/\s#{"Partido " + party.description}\W/).length
        party_count[index] += title.scan(/^#{"Partido " + party.description}\s/).length

        party_count[index] += content.scan(/\s#{party.party_name}\W/).length
        party_count[index] += content.scan(/^#{party.party_name}\s/).length

        party_count[index] += content.scan(/\s#{"Partido " + party.description}\W/).length
        party_count[index] += content.scan(/^#{"Partido " + party.description}\s/).length

      elsif party.description === "Aliança"
        party_count[index] = title.scan(/\s#{"O " + party.description}\W/).length
        party_count[index] += title.scan(/^#{"O " + party.description}\s/).length

        party_count[index] += content.scan(/\s#{"O " + party.description}\W/).length
        party_count[index] += content.scan(/^#{"O " + party.description}\s/).length

      else
        party_count[index] = title.scan(/\s#{party.party_name}\W/).length #space in the beggining and end of word
        party_count[index] += title.scan(/^#{party.party_name}\s/).length #beggining of the line word with space after

        party_count[index] += title.scan(/\s#{party.description}\W/).length
        party_count[index] += title.scan(/^#{party.description}\s/).length

        party_count[index] += content.scan(/\s#{party.party_name}\W/).length
        party_count[index] += content.scan(/^#{party.party_name}\s/).length

        party_count[index] += content.scan(/\s#{party.description}\W/).length
        party_count[index] += content.scan(/^#{party.description}\s/).length
      end
    end

    most_mentioned = party_count.each_with_index.max(4)

    if most_mentioned[0][0] >= 2
      ArticlesPartido.create(partido_id: most_mentioned[0][1] + 1, article_id: self.id)
      associated_parties = Partido.find(most_mentioned[0][1] + 1).party_name
      associated = true

        if most_mentioned[1][0] >= 3
          ArticlesPartido.create(partido_id: most_mentioned[1][1] + 1, article_id: self.id)
          associated_parties += "," + Partido.find(most_mentioned[1][1] + 1).party_name
        end

        if most_mentioned[2][0] >= 3
          ArticlesPartido.create(partido_id: most_mentioned[2][1] + 1, article_id: self.id)
          associated_parties += "," + Partido.find(most_mentioned[2][1] + 1).party_name
        end

        if most_mentioned[3][0] >= 3
          ArticlesPartido.create(partido_id: most_mentioned[3][1] + 1, article_id: self.id)
          associated_parties += "," + Partido.find(most_mentioned[3][1] + 1).party_name
        end
    end

    { associated: associated, tags: associated_parties }
  end

  def self.validate(value, party_id, article_id)
    if value >= 1
      ArticlesPartido.create(partido_id: party_id + 1, article_id: article_id)
      return true
    end
    return false
  end
end