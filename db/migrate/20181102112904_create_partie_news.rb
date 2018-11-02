class CreatePartieNews < ActiveRecord::Migration[5.2]
  def change
    create_table :articles_partidos, id: false do |t|
        t.belongs_to :partido, index: true
        t.belongs_to :article, index: true
    end
  end
end
