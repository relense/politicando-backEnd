class CreateCouncilman < ActiveRecord::Migration[5.2]
  def change
    create_table :councilmen do |t|
      t.integer :parlament_id, null: false
      t.integer :registration_id, null: false
      t.string :parlament_name, null: false
      t.string :parlament_complete_name
      t.integer :electoral_circle_id, null: false
      t.string :electoral_circle_description, null: false
      t.string :legislature, null: false
      t.string :current_position, null: false
      t.belongs_to :partido, index: true

      t.timestamps
    end
  end
end
