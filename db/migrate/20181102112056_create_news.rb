class CreateNews < ActiveRecord::Migration[5.2]
  def change
    create_table :articles do |t|
        t.string :title, null: false
        t.string :content, null: false
        t.string :image_link

        t.timestamps
    end
  end
end
