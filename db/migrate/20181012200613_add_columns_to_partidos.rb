class AddColumnsToPartidos < ActiveRecord::Migration[5.2]
  def change
      add_column :partidos, :deputies_republic_chamber, :integer
      add_column :partidos, :deputies_acores_legislative_chamber, :integer
      add_column :partidos, :deputies_madeira_legislative_chamber, :integer
      add_column :partidos, :member_europen_parlament, :integer
      add_column :partidos, :president_town_hall, :integer
      add_column :partidos, :councilmen_municipal, :integer
  end
end
