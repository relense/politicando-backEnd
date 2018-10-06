class CreatePartidos < ActiveRecord::Migration[5.2]
  def change
    create_table :partidos do |t|
      t.string :party_name, null: false
      t.string :description, null: false
      t.timestamps
    end
  end
end
