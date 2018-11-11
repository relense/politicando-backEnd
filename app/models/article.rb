class Article < ApplicationRecord
    has_and_belongs_to_many :partidos

    def associate_partie
      parties = Partido.all

      exists_partie = false

        parties.each do |partie|
          if title.include? " #{partie.party_name} " && "#{partie.description}"
            ArticlesPartido.create(partido_id: partie.id, article_id: self.id)
            exists_partie = true
            break
          end
        end

      if !exists_partie
        parties.each do |partie|
          if content.include? " #{partie.party_name} " && "#{partie.description}"
            ArticlesPartido.create(partido_id: partie.id, article_id: self.id)
            exists_partie = true
            break
          end
        end
      end

      exists_partie

    end
end
